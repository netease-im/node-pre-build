#! /usr/bin/env node
const shell = require('shelljs')
const fetch = require('node-fetch')
const path = require('path')
const tar = require('tar')
const download = require('download')
const fs = require('fs')
const nodeAbi = require('node-abi')
const { Command } = require('commander')
const program = new Command()

if (!package_json.node_pre_build) {
    package_json.node_pre_build = {}
}

const sdk_path = path.join(process.cwd(), package_json.node_pre_build["sdk-dir"] ? package_json.node_pre_build["sdk-dir"] : 'sdk')
const temp_path = path.join(process.cwd(), 'temporary')
const package_json = require(process.cwd() + '/package.json')
const platform = process.platform

const build = (buildTool, runtime, version, arch) => {
    let shell_command
    if (buildTool == 'cmake-js') {
        let generator_arch = ""
        let generator = ""
        if (platform == "win32") {
            generator = "Visual Studio 15 2017"
            if (arch == "ia32")
                generator_arch = "Win32"
            else if (arch == "x64")
                generator_arch = "x64"
        } else if (platform == "darwin") {
            generator = "Xcode"
        } else if (platform == "linux") {
            generator = "Unix Makefiles"
        }
        shell_command = `npx cmake-js rebuild -G \\"${generator}\\" -A ${generator_arch}`
        if (runtime)
            shell_command += ` --runtime ${runtime}`
        if (version)
            shell_command += ` --runtime-version ${version}`
        if (arch)
            shell_command += ` --arch ${arch}`
    } else {
        shell_command = `npx node-gyp rebuild`
        if (runtime == 'electron')
            shell_command += ' --dist-url=https://electronjs.org/headers'
        if (version)
            shell_command += ` --target ${version}`
        if (arch)
            shell_command += ` --arch ${arch}`
    }
    shell.exec(shell_command)
}

const downloadSDK = (name_sdk, arch, publish_json) => {
    return new Promise((resolve, reject) => {
        const sdk_list = publish_json.message[package_json.version]
        let sdk_url
        sdk_list.forEach(member => {
            if (member.filename.includes(name_sdk)) {
                sdk_url = member.cdnlink
            }
        })
        if (!sdk_url) {
            return reject("[node_pre_build] Failed to get download url of the pre-built sdk")
        }
        const matchPlatform = platform === 'win32' ? 'windows' : 'macosx'
        const matchArch = arch === 'ia32' ? 'x86' : 'x64'
        console.info(`[node_pre_build] Downloading prebuilt sdk from ${sdk_url}`)
        download(sdk_url, temp_path, {
            strip: 1,
            extract: true
        }).then(() => {
            fs.readdirSync(temp_path).forEach(file => {
                console.info(`[node_pre_build] found package: ${file}`)
                if (file.includes(matchPlatform) && file.includes(matchArch)) {
                    const sdk_archive = path.join(temp_path, file)
                    if (!fs.existsSync(sdk_path)) {
                        fs.mkdirSync(sdk_path)
                    }
                    console.info(`[node_pre_build] Extract file from ${sdk_archive} to ${sdk_path}`)
                    tar.extract({
                        file: sdk_archive,
                        cwd: sdk_path,
                        sync: true
                    })
                    return resolve()
                }
            })
            return reject('[node_pre_build] No matching sdk package found.')
        }).catch((err) => {
            return reject(err)
        })
    })
}

const downloadAddon = (name_addon, arch, fallBackToBuild, publish_json) => {
    return new Promise((resolve, reject) => {
        const addon_list = publish_json.electron[package_json.version]
        let addon_url
        addon_list.forEach(member => {
            if (member.filename.includes(name_addon) && member.filename.includes(platform) && member.filename.includes(arch) &&
                process.versions.electron && member.filename.includes(nodeAbi.getAbi(process.versions.electron, 'electron'))) {
                addon_url = member.cdnlink
            }
        })
        if (!addon_url) {
            if (!fallBackToBuild) {
                return reject("[node_pre_build] Failed to get download url of the pre-built addon.")
            }
            console.info("[node_pre_build] Failed to get download url of the pre-built addon, falling back to build.")
            build(package_json.node_pre_build['build-tool'])
            return resolve()
        }
        console.info(`[node_pre_build] Downloading prebuilt addon from ${addon_url}`)
        download(addon_url, sdk_path, {
            strip: 1,
            extract: true
        }).catch((err) => {
            if (!fallBackToBuild) {
                return reject(err)
            }
            console.info(`[node_pre_build] Failed to download pre-built addon from ${addon_url}, falling back to build.`)
            build(package_json.node_pre_build['build-tool'])
            return resolve()
        })
    })
}

const install = (options) => {
    let name_addon = package_json.node_pre_build['name'] ? package_json.node_pre_build['name'] : (package_json.node_pre_build['name-addon'] ? package_json.node_pre_build['name-addon'] : package_json.name)
    let name_sdk = package_json.node_pre_build['name'] ? package_json.node_pre_build['name'] : (package_json.node_pre_build['name-sdk'] ? package_json.node_pre_build['name-addon'] : package_json.name)
    let arch = package_json.node_pre_build['arch']

    name_addon = options.name ? options.name : (options.nameAddon ? options.nameAddon : name_addon)
    name_sdk = options.name ? options.name : (name_sdk = options.nameSdk ? options.nameSdk : name_sdk)

    arch = options.arch ? options.arch : arch
    if (!arch) {
        arch = process.arch
    }

    //fetch publish list
    fetch('http://publish.netease.im/api/list').then(res => res.json()).then(json => {
        return downloadSDK(name_sdk, arch, json).then(() => {
            return downloadAddon(name_addon, arch, options.fallBackToBuild, json)
        })
    }).catch(err => {
        console.error(err)
    })
}

// command-line options
//clean
program
    .command('clean')
    .description('Clean installed pre-built binary')
    .action((options) => {
        console.info(`[node_pre_build] removing ${sdk_path}.`)
        fs.rmdirSync(sdk_path, { recursive: true, force: true })
        console.info(`[node_pre_build] removing ${temp_path}.`)
        fs.rmdirSync(temp_path, { recursive: true, force: true })
    })

//install
program
    .command('install')
    .description('Install pre-built binary for module')
    .option('-n, --name', 'name of pre-built addon & sdk, convenient when addon and sdk keep the same name.')
    .option('-na, --name-addon', 'name of pre-built addon.')
    .option('-ns, --name-sdk', 'name of pre-built sdk.')
    .option('-a, --arch <architecture>', 'architecture of the host machine.')
    .option('--fall-back-to-build [build-script]', 'build when download pre-built binary failed.')
    .action((options) => {
        if (fs.existsSync(sdk_path) && fs.readdirSync(sdk_path).length > 0) {
            console.info(`[node_pre_build] sdk already installed in ${sdk_path}.`)
            return
        }
        install(options)
    })

//reinstall
program
    .command('reinstall')
    .description('Reinstall pre-built binary for module')
    .option('-n, --name', 'name of pre-built addon & sdk, convenient when addon and sdk keep the same name.')
    .option('-na, --name-addon', 'name of pre-built addon.')
    .option('-ns, --name-sdk', 'name of pre-built sdk.')
    .option('-a, --arch <architecture>', 'architecture of the host machine.')
    .option('--fall-back-to-build [build-script]', 'build when download pre-built binary failed.')
    .action((options) => {
        console.info(`[node_pre_build] removing ${sdk_path}.`)
        fs.rmdirSync(sdk_path, { recursive: true, force: true })
        console.info(`[node_pre_build] removing ${temp_path}.`)
        fs.rmdirSync(sdk_path, { recursive: true, force: true })
        install(options)
    })

//build
program
    .command('build')
    .description('Build and pack your pre-built binaries.')
    .option('-bt, --build-tool <build-tool>', 'cmake-js or node-pre-gyp.')
    .option('-bd, --binary-dir <package-dir>', 'dir path to pre-built binaries, relative path to cwd.')
    .option('-pd, --package-dir <package-dir>', 'dir path to store packed pre-built binaries, relative path to cwd.')
    .option('-r, --runtime <runtime...>', 'array of runtimes to build for, such as [electron, node, nw].')
    .option('-rv, --runtime-version <runtime-version...>', 'array of runtime versions to build for, support multiple versions.')
    .option('-a, --arch <arch...>', 'array of architechtures to build for, such as [x64, ia32, arm64, arm].')
    .option('-p, --pack', 'pack the binaries after build.')
    .action((options) => {
        const name_addon = package_json.node_pre_build['name'] ? package_json.node_pre_build['name'] : (package_json.node_pre_build['name-addon'] ? package_json.node_pre_build['name-addon'] : package_json.name)
        const buildTool = options.buildTool ? options.buildTool : package_json.node_pre_build['build-tool']
        const binary_dir = options.binaryDir ? options.binaryDir : (package_json.node_pre_build['binary-dir'] ? package_json.node_pre_build['binary-dir'] : "build/Release")
        const package_dir = options.packageDir ? options.packageDir : (package_json.node_pre_build['package-dir'] ? package_json.node_pre_build['package-dir'] : "packages")

        let runtime_array = options.runtime ? options.runtime : package_json.node_pre_build['runtime']
        let runtime_version_array = options.runtimeVersion ? options.runtimeVersion : package_json.node_pre_build['runtime-version']
        let arch_array = options.arch ? options.arch : package_json.node_pre_build['arch']
        if (!Array.isArray(runtime_array))
            runtime_array = [runtime_array]
        if (!Array.isArray(runtime_version_array))
            runtime_version_array = [runtime_version_array]
        if (!Array.isArray(arch_array))
            arch_array = [arch_array]

        if (buildTool != 'cmake-js' && buildTool != 'node-pre-gyp') {
            console.error("'build-tool' should be cmake-js or node-pre-gyp.")
        }
        if (!fs.existsSync(process.cwd() + '/' + package_dir))
            fs.mkdirSync(process.cwd() + '/' + package_dir)
        runtime_array.forEach(runtime => {
            runtime_version_array.forEach(version => {
                arch_array.forEach(arch => {
                    build(buildTool, runtime, version, arch)
                    if (!options.pack)
                        return
                    if (!version || !runtime || !binary_dir || !package_dir) {
                        console.error('pack needs runtime, runtime-version, binary-dir, package-dir defined.')
                    }
                    const abi_version = nodeAbi.getAbi(version, runtime)
                    tar.create({
                        gzip: true,
                        sync: true,
                        cwd: process.cwd() + '/' + binary_dir,
                        file: `${process.cwd() + '/' + package_dir}/${name_addon}-v${package_json.version}-abi${abi_version}-${platform}-${arch}.tar.gz`,
                        filter: (path, stat) => {
                            if (path.match(/\.pdb|\.dll|\.node|\.framework|\.dylib/g) !== null) {
                                console.info(`[node_pre_build] ${path} packed.`)
                                return true
                            }
                        }
                    }, fs.readdirSync(process.cwd() + '/' + binary_dir))
                });
            });
        });
    })


//parse
program.parse()