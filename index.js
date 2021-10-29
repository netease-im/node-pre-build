#! /usr/bin/env node
const shell = require('shelljs')
const fetch = require('node-fetch')
const path = require('path')
const tar = require('tar')
const glob = require('glob')
const download = require('download')
const fse = require('fs-extra')
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
        if (!fse.pathExistsSync(path.join(process.cwd(), binary_dir))) {
            fse.mkdirSync(path.join(process.cwd(), binary_dir), { recursive: true })
        }
        files.forEach(filepath => {
            fse.copySync(filepath, path.join(process.cwd(), binary_dir, path.basename(filepath)), { dereference: true })
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
        if (platform == "darwin") {
            generator = "Xcode"
        }
        shell_command = `npx cmake-js rebuild -G ${generator} -A ${generator_arch} --arch ${arch} --runtime ${runtime} --runtime-version ${version}`
        if (is_electron) {
            shell.exec('npm config set cmake_NODE_V8_COMPRESS_POINTERS TRUE')
        } else {
            shell.exec('npm config delete cmake_NODE_V8_COMPRESS_POINTERS')
        }

    } else if (buildTool == 'node-gyp') {
        console.log('node-gyp build start')
        let msvcVersion = '2017'
        let silent = false
        let distUrl = 'https://electronjs.org/headers'
        let gypPath = path.join(process.cwd(), '/node_modules/node-gyp/bin/node-gyp.js')
        let gypExec = `node ${gypPath}`
        let command = [`${gypExec} configure`]
        command.push(`--arch=${arch} --msvs_version=${msvcVersion}`)
        if (is_electron) {
            runtime = 'electron'
            target = electron_version
            command.push(`--target=${target} --dist-url=${distUrl}`)
        } else {
            if(runtime.length == 0 && version.length == 0){
                target = process.version.match(/^v(\d+\.\d+)/)[1]
                runtime = 'node'
            }else{
                target = version;
            }
        }
        console.log(command.join(' '))
        console.log('[build] platform:', platform)
        console.log('[build] arch:', arch)
        console.log('[build] target:', target)
        console.log('[build] runtime:', runtime)

        shell.exec(`${gypExec} clean`, { silent })
        shell.exec(command.join(' '), { silent })
        shell.exec(`${gypExec} build`, { silent })

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
            if (package_json.version.split('-')[0] === temp)
                sdk_list = publish_json[sdk_group][temp]
        });
        let sdk_url
        sdk_list.forEach(member => {
            if (member.filename.includes(name_sdk) && member.filename.includes(platform) && member.filename.includes(arch)) {
                sdk_url = member.cdnlink
            }
        })
        if (!sdk_url) {
            return reject("[node_pre_build] Failed to get download url of the pre-built sdk")
        }
        console.info(`[node_pre_build] Downloading prebuilt sdk from ${sdk_url} to ${sdk_path}`)
        download(sdk_url, sdk_path, {
            extract: true
        }).then(() => {
            console.info(`[node_pre_build] Downloading prebuilt sdk complete`)
            return resolve()
        }).catch((err) => {
            return reject(err)
        })
    })
}

function downloadAddon(name_addon, arch, fallBackToBuild, publish_json) {
    return new Promise((resolve, reject) => {
        let addon_list = []
        Object.keys(publish_json[addon_group]).forEach(temp => {
            if (package_json.version.split('-')[0] === temp)
                addon_list = publish_json[addon_group][temp]
        });
        let addon_url
        let abi_version
        if (is_electron) {
            abi_version = nodeAbi.getAbi(electron_version, 'electron')
        } else {
            abi_version = nodeAbi.getAbi(process.versions.node, 'node')
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

    //fetch publish list··
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
        fse.removeSync(sdk_path)
        console.info(`[node_pre_build] removing ${temp_path}.`)
        fse.removeSync(temp_path)
    })

//install
program
    .command('install')
    .description('Install pre-built binary for module')
    .option('-a, --arch <architecture>', 'architecture of the host machine.')
    .option('--fall-back-to-build [build-script]', 'build when download pre-built binary failed.')
    .action((options) => {
        if (fse.pathExistsSync(sdk_path) && fse.readdirSync(sdk_path).length > 0) {
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
        fse.removeSync(sdk_path)
        console.info(`[node_pre_build] removing ${temp_path}.`)
        fse.removeSync(temp_path)
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

        if (buildTool != 'cmake-js' && buildTool != 'node-gyp') {
            console.error("'build-tool' should be cmake-js or node-gyp.")
        }
        if (!fse.pathExistsSync(process.cwd() + '/' + package_dir))
            fse.mkdirSync(process.cwd() + '/' + package_dir)
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
                    }, fse.readdirSync(process.cwd() + '/' + binary_dir))
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
        const version = package_json.version
        const git = require('git-last-commit')
        git.getLastCommit(function (err, commit) {
            let shell_command = 'npm publish'
            if (options.dryRun)
                shell_command += ' --dry-run'
            if (commit.tags.length == 0) {
                return
            }
            shell.exec(`npm version ${commit.tags[0]} --no-git-tag-version`)
            if (commit.branch !== "master" && commit.branch !== "main") {
                shell_command += ` --tag ${commit.branch}`
            }

            shell.exec(shell_command)
            //recover version
            shell.exec(`npm version ${version} --no-git-tag-version`)
        }, {
            dst: process.cwd()
        });
    })
//parse
program.parse()