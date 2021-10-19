#! /usr/bin/env node
const shell = require('shelljs')
const fetch = require('node-fetch')
const path = require('path')
const tar = require('tar')
const glob = require('glob')
const download = require('download')
const fs = require('fs')
const nodeAbi = require('node-abi')
const { Command } = require('commander')
const program = new Command()
const package_json = require(process.cwd() + '/package.json')
if (!package_json.node_pre_build) {
    package_json.node_pre_build = {}
}
const name_addon = package_json.node_pre_build['name'] ? package_json.node_pre_build['name'] : (package_json.node_pre_build['name-addon'] ? package_json.node_pre_build['name-addon'] : package_json.name)
const name_sdk = package_json.node_pre_build['name'] ? package_json.node_pre_build['name'] : (package_json.node_pre_build['name-sdk'] ? package_json.node_pre_build['name-sdk'] : package_json.name)
const sdk_path = path.join(process.cwd(), package_json.node_pre_build["sdk-dir"] ? package_json.node_pre_build["sdk-dir"] : 'sdk')
const temp_path = path.join(process.cwd(), 'temporary')
const sdk_group = package_json.node_pre_build["sdk-group"]
const addon_group = package_json.node_pre_build["addon-group"]
const buildTool = package_json.node_pre_build['build-tool']
const binary_dir = package_json.node_pre_build['binary-dir'] ? package_json.node_pre_build['binary-dir'] : "build/Release"
const package_dir = package_json.node_pre_build['package-dir'] ? package_json.node_pre_build['package-dir'] : "packages"
const platform = process.platform
if (!sdk_group || !addon_group) {
    console.error("[node_pre_build] please specify 'sdk-group' and 'addon-group' in field 'node_pre_build'.")
}
// check if project has electron dependency
const node_modules = require('node_modules-path');
let is_electron = false
let electron_version
if (node_modules('electron')) {
    is_electron = true
    electron_version = require(path.join(node_modules('electron'), 'electron', 'package.json')).version
}

function copySDKToBinaryDir() {
    glob("/**/+(*.dll|*.framework|*.dylib|*.so|*.node)", {
        root: sdk_path,
        absolute: true
    }, function (er, files) {
        if (!fs.existsSync(path.join(process.cwd(), binary_dir))) {
            fs.mkdirSync(path.join(process.cwd(), binary_dir), { recursive: true })
        }
        files.forEach(filepath => {
            fs.copyFileSync(filepath, path.join(process.cwd(), binary_dir, path.basename(filepath)))
        })
    })
}

function build(buildTool, runtime, version, arch) {
    let shell_command
    if (!arch)
        arch = process.arch
    if (!runtime || !version) {
        if (is_electron) {
            runtime = 'electron'
            version = electron_version
        } else {
            runtime = 'node'
            version = process.versions.node
        }
    }
    if (buildTool == 'cmake-js') {
        let generator_arch = ""
        let generator = ""
        if (platform == "win32") {
            generator = `"Visual Studio 15 2017"`
            if (arch == "ia32")
                generator_arch = "Win32"
            else if (arch == "x64")
                generator_arch = "x64"
        } else if (platform == "darwin") {
            generator = "Xcode"
        } else if (platform == "linux") {
            generator = "Unix Makefiles"
        }
        shell_command = `npx cmake-js rebuild -G ${generator} -A ${generator_arch} --arch ${arch} --runtime ${runtime} --runtime-version ${version}`
        if (is_electron) {
            shell.exec('npm config set cmake_NODE_V8_COMPRESS_POINTERS TRUE')
        } else {
            shell.exec('npm config delete cmake_NODE_V8_COMPRESS_POINTERS')
        }

    } else {
        shell_command = `npx node-gyp rebuild --target ${version}  --arch ${arch}`
        if (is_electron)
            shell_command += ' --dist-url=https://electronjs.org/headers'
    }
    shell.exec(shell_command)
    copySDKToBinaryDir()
}

function downloadSDK(name_sdk, arch, publish_json) {
    return new Promise((resolve, reject) => {
        let sdk_list = []
        Object.keys(publish_json[sdk_group]).forEach(temp => {
            if (package_json.version.includes(temp))
                sdk_list = publish_json[sdk_group][temp]
        });
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
        const matchArch = arch === 'ia32' ? 'x86' : (platform === 'win32' ? 'x64' : 'x86_64')
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
                        sync: true,
                        filter: (path, entry) => {
                            if (path.includes('._'))
                                return false
                            return true
                        }
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

function downloadAddon(name_addon, arch, fallBackToBuild, publish_json) {
    return new Promise((resolve, reject) => {
        let addon_list = []
        Object.keys(publish_json[addon_group]).forEach(temp => {
            if (package_json.version.includes(temp))
                addon_list = publish_json[addon_group][temp]
        });
        let addon_url
        let abi_version
        if (is_electron) {
            abi_version = nodeAbi.getAbi(electron_version, 'electron')
        } else {
            abi_version = nodeAbi.getAbi(process.versions.node, 'electron')
        }
        addon_list.forEach(member => {
            if (member.filename.includes(name_addon) && member.filename.includes(platform) && member.filename.includes(arch) && member.filename.includes(abi_version)) {
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
        }).then(() => {
            copySDKToBinaryDir()
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

function install(options) {
    let arch = package_json.node_pre_build['arch']
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
    .option('-r, --runtime <runtime...>', 'array of runtimes to build for, such as [electron, node, nw].')
    .option('-rv, --runtime-version <runtime-version...>', 'array of runtime versions to build for, support multiple versions.')
    .option('-a, --arch <arch...>', 'array of architechtures to build for, such as [x64, ia32, arm64, arm].')
    .option('-p, --pack', 'pack the binaries after build.')
    .action((options) => {
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

//publish
program
    .command('publish')
    .description('publish your npm package with certain version based on git branch and commit count.')
    .option('--dry-run', 'runs npm publish using --dry-run.')
    .action((options) => {
        const git = require('git-rev-sync')
        const version = package_json.version
        const name = package_json.name
        if (git.branch === "master" || git.branch === "main") {
            if (package_json.name.includes('@yxfe/')) {
                package_json.name = package_json.name.slice(package_json.name.indexOf('/') + 1)
                fs.writeFileSync('package.json', JSON.stringify(package_json, null, 2))
            }
            shell.exec(`npm version ${version}`)
        } else {
            if (!package_json.name.includes('@yxfe/')) {
                package_json.name = `@yxfe/${package_json.name}`
                fs.writeFileSync('package.json', JSON.stringify(package_json, null, 2))
            }
            shell.exec(`npm version --no-git-tag-version ${version}-${git.branch()}-${git.count()}`)
        }
        if (options.dryRun) {
            shell.exec('npm publish --dry-run')
        } else {
            shell.exec('npm publish')
        }
        package_json.version = version
        package_json.name = name
        fs.writeFileSync('package.json', JSON.stringify(package_json, null, 2))
    })

//parse
program.parse()