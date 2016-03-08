import extend = require('xtend')
import Promise = require('any-promise')
import { dirname } from 'path'
import { EventEmitter } from 'events'
import { resolveDependency, resolveTypeDependencies } from './lib/dependencies'
import compile, { Options as CompileOptions, CompiledOutput } from './lib/compile'
import { findProject } from './utils/find'
import { transformConfig, mkdirp, touch, writeFile, transformDtsFile } from './utils/fs'
import { getTypingsLocation, getDependencyLocation } from './utils/path'
import { parseDependency, parseDependencyRaw } from './utils/parse'
import { DependencyTree, Dependency, DependencyBranch, Emitter, DependencyExpression } from './interfaces'

/**
 * Options for installing a new dependency.
 */
export interface InstallDependencyOptions {
  save?: boolean
  saveDev?: boolean
  savePeer?: boolean
  ambient?: boolean
  cwd: string
  emitter?: Emitter
}

/**
 * Only options required for a full install.
 */
export interface InstallOptions {
  cwd: string
  production?: boolean
  emitter?: Emitter
}

/**
 * Install all dependencies on the current project.
 */
export function install (options: InstallOptions): Promise<{ tree: DependencyTree }> {
  const { cwd, production } = options
  const emitter = options.emitter || new EventEmitter()

  return resolveTypeDependencies({ cwd, emitter, ambient: true, peer: true, dev: !production })
    .then(tree => {
      const cwd = dirname(tree.src)
      const queue: Array<Promise<any>> = []

      function addToQueue (deps: DependencyBranch, ambient: boolean) {
        for (const name of Object.keys(deps)) {
          const tree = deps[name]

          queue.push(installDependencyTree(tree, { cwd, name, ambient, emitter, meta: true }))
        }
      }

      addToQueue(tree.dependencies, false)
      addToQueue(tree.devDependencies, false)
      addToQueue(tree.peerDependencies, false)
      addToQueue(tree.ambientDependencies, true)
      addToQueue(tree.ambientDevDependencies, true)

      return Promise.all(queue)
        .then(installed => {
          if (installed.length === 0) {
            const { typingsDir, mainDtsFile, browserDtsFile } = getTypingsLocation({ cwd })

            return mkdirp(typingsDir)
              .then(() => {
                return Promise.all([
                  touch(mainDtsFile, {}),
                  touch(browserDtsFile, {})
                ])
              })
          }
        })
        .then(() => ({ tree }))
    })
}

/**
 * Parse the raw dependency string before installing.
 */
export function installDependencyRaw (raw: string, options: InstallDependencyOptions): Promise<CompiledOutput> {
  return new Promise((resolve) => {
    return resolve(installDependency(parseDependencyRaw(raw, options), options))
  })
}

/**
 * Install a dependency into the currect project.
 */
export function installDependency (expression: DependencyExpression, options: InstallDependencyOptions): Promise<CompiledOutput> {
  return findProject(options.cwd)
    .then(
      (cwd) => installTo(expression, extend(options, { cwd })),
      () => installTo(expression, options)
    )
}

/**
 * Install from a dependency string.
 */
function installTo (expression: DependencyExpression, options: InstallDependencyOptions): Promise<CompiledOutput> {
  const { dependency } = expression
  const { cwd, ambient } = options
  const emitter = options.emitter || new EventEmitter()

  return resolveDependency(dependency, { cwd, emitter, dev: false, peer: false, ambient: false })
    .then(tree => {
      const name = expression.name || tree.name

      if (!name) {
        return Promise.reject(new TypeError(`Unable to install dependency from "${tree.raw}" without a name`))
      }

      return installDependencyTree(tree, {
        cwd,
        name,
        ambient,
        emitter,
        meta: true
      })
        .then(result => {
          return writeToConfig(name, tree.raw, options).then(() => result)
        })
    })
}

/**
 * Compile a dependency tree into the users typings.
 */
function installDependencyTree (tree: DependencyTree, options: CompileOptions): Promise<CompiledOutput> {
  return compile(tree, options).then(result => writeDependency(result, options))
}

/**
 * Write a dependency to the configuration file.
 */
function writeToConfig (name: string, raw: string, options: InstallDependencyOptions) {
  if (options.save || options.saveDev || options.savePeer) {
    return transformConfig(options.cwd, config => {
      // Extend different fields depending on the option passed in.
      if (options.save) {
        if (options.ambient) {
          config.ambientDependencies = extend(config.ambientDependencies, { [name]: raw })
        } else {
          config.dependencies = extend(config.dependencies, { [name]: raw })
        }
      } else if (options.saveDev) {
        if (options.ambient) {
          config.ambientDevDependencies = extend(config.ambientDevDependencies, { [name]: raw })
        } else {
          config.devDependencies = extend(config.devDependencies, { [name]: raw })
        }
      } else if (options.savePeer) {
        if (options.ambient) {
          return Promise.reject(new TypeError('Unable to use `savePeer` with the `ambient` flag'))
        } else {
          config.peerDependencies = extend(config.peerDependencies, { [name]: raw })
        }
      }

      return config
    })
  }

  return Promise.resolve()
}

/**
 * Write a dependency to the filesytem.
 */
export function writeDependency (output: CompiledOutput, options: CompileOptions): Promise<CompiledOutput> {
  const location = getDependencyLocation(options)

  // Execute the dependency creation flow.
  function create (path: string, file: string, contents: string, dtsFile: string) {
    return mkdirp(path)
      .then(() => writeFile(file, contents))
      .then(() => transformDtsFile(dtsFile, typings => typings.concat([file])))
  }

  // Create both typings concurrently.
  return Promise.all([
    create(location.mainPath, location.mainFile, output.main, location.mainDtsFile),
    create(location.browserPath, location.browserFile, output.browser, location.browserDtsFile)
  ]).then(() => output)
}
