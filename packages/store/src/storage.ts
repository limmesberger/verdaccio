import assert from 'assert';
import async, { AsyncResultArrayCallback } from 'async';
import buildDebug from 'debug';
import _ from 'lodash';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';

import { hasProxyTo } from '@verdaccio/config';
import {
  API_ERROR,
  DIST_TAGS,
  HTTP_STATUS,
  errorUtils,
  pkgUtils,
  validatioUtils,
} from '@verdaccio/core';
import { ProxyStorage } from '@verdaccio/proxy';
import { IProxy } from '@verdaccio/proxy';
import { ReadTarball } from '@verdaccio/streams';
import {
  convertDistRemoteToLocalTarballUrls,
  convertDistVersionToLocalTarballsUrl,
} from '@verdaccio/tarball';
import {
  Callback,
  CallbackAction,
  Config,
  DistFile,
  GenericBody,
  IReadTarball,
  IUploadTarball,
  Manifest,
  StringValue,
  Version,
} from '@verdaccio/types';

import AbstractStorage from './abstract-storage';
import { LocalStorage } from './local-storage';
// import { isPublishablePackage, validateInputs } from './star-utils';
import {
  STORAGE,
  checkPackageLocal,
  checkPackageRemote,
  cleanUpLinksRef,
  generatePackageTemplate,
  mergeUplinkTimeIntoLocal,
  normalizeDistTags,
  publishPackage,
} from './storage-utils';
import { IGetPackageOptions, IGetPackageOptionsNext, ISyncUplinks } from './type';
// import { StarBody, Users } from './type';
import { updateVersionsHiddenUpLink } from './uplink-util';
import { getVersion } from './versions-utils';

const debug = buildDebug('verdaccio:storage');
class Storage extends AbstractStorage {
  public constructor(config: Config) {
    super(config);
    debug('uplinks available %o', Object.keys(this.uplinks));
  }

  /**
   *  Add a {name} package to a system
   Function checks if package with the same name is available from uplinks.
   If it isn't, we create package locally
   Used storages: local (write) && uplinks
   */
  public async addPackage(name: string, metadata: any, callback: Function): Promise<void> {
    try {
      debug('add package for %o', name);
      await checkPackageLocal(name, this.localStorage);
      debug('look up remote for %o', name);
      await checkPackageRemote(
        name,
        this.isAllowPublishOffline(),
        this._syncUplinksMetadata.bind(this)
      );
      debug('publishing a package for %o', name);
      await publishPackage(name, metadata, this.localStorage as LocalStorage);
      // TODO: return published data and replace callback by a promise
      callback(null, true);
    } catch (err: any) {
      debug('error on add a package for %o with error %o', name, err);
      callback(err);
    }
  }

  public async updateVersionsManifest(name: string): Promise<void> {
    // we check if package exist already locally
    const manifest = await this.getPackageLocalMetadata(name);
  }

  /**
   * Add a {name} package to a system
   Function checks if package with the same name is available from uplinks.
   If it isn't, we create package locally
   Used storages: local (write) && uplinks
   */
  public async addPackageNext(name: string, metadata: Manifest): Promise<Manifest> {
    try {
      debug('add package for %o', name);
      await checkPackageLocal(name, this.localStorage);
      debug('look up remote for %o', name);
      await checkPackageRemote(
        name,
        this.isAllowPublishOffline(),
        this._syncUplinksMetadata.bind(this)
      );
      debug('publishing a package for %o', name);
      // FIXME: publishPackage should return fresh metadata from backend
      // instead return metadata
      await publishPackage(name, metadata, this.localStorage as LocalStorage);
      return metadata;
    } catch (err: any) {
      debug('error on add a package for %o with error %o', name, err);
      throw err;
    }
  }

  /**
   * Add a new version of package {name} to a system
   Used storages: local (write)
   @deprecated use addVersionNext
   */
  public addVersion(
    name: string,
    version: string,
    metadata: Version,
    tag: StringValue,
    callback: CallbackAction
  ): void {
    debug('add the version %o for package %o', version, name);
    this.localStorage.addVersion(name, version, metadata, tag, callback);
  }

  /**
   * Change an existing package (i.e. unpublish one version)
   Function changes a package info from local storage and all uplinks with write access./
   Used storages: local (write)
   */
  public changePackage(
    name: string,
    metadata: Manifest,
    revision: string,
    callback: Callback
  ): void {
    debug('change existing package for package %o revision %o', name, revision);
    this.localStorage.changePackage(name, metadata, revision, callback);
  }

  /**
   * Change an existing package (i.e. unpublish one version)
   Function changes a package info from local storage and all uplinks with write access./
   Used storages: local (write)
   */
  public async changePackageNext(
    name: string,
    metadata: Manifest,
    revision: string
  ): Promise<void> {
    debug('change existing package for package %o revision %o', name, revision);
    this.localStorage.changePackageNext(name, metadata, revision);
  }

  /**
   * Remove a package from a system
   Function removes a package from local storage
   Used storages: local (write)
   */
  public async removePackage(name: string): Promise<void> {
    debug('remove packagefor package %o', name);
    await this.localStorage.removePackage(name);
  }

  /**
   Remove a tarball from a system
   Function removes a tarball from local storage.
   Tarball in question should not be linked to in any existing
   versions, i.e. package version should be unpublished first.
   Used storage: local (write)
   */
  public removeTarball(
    name: string,
    filename: string,
    revision: string,
    callback: CallbackAction
  ): void {
    this.localStorage.removeTarball(name, filename, revision, callback);
  }

  /**
   * Upload a tarball for {name} package
   Function is synchronous and returns a WritableStream
   Used storages: local (write)
   */
  public addTarball(name: string, filename: string): IUploadTarball {
    debug('add tarball for package %o', name);
    return this.localStorage.addTarball(name, filename);
  }

  public async getTarballNext(
    name: string,
    filename: string,
    { signal, enableRemote }
  ): Promise<PassThrough | void> {
    debug('get tarball for package %o filename %o', name, filename);
    let isOpen = false;
    const localStream = await this.getLocalTarball(name, filename, { signal });
    localStream.on('open', async () => {
      isOpen = true;
    });

    try {
      // throw new Error('no uplink');
      const localTarballStream = new PassThrough();
      await pipeline(localStream, localTarballStream, { signal });
      return localTarballStream;
    } catch (err: any) {
      this.logger.error({ err: err.message }, 'some error on getTarballNext @{err}');

      // if (isOpen || err.status !== HTTP_STATUS.NOT_FOUND) {
      //   throw err;
      // }
      // if (true) {
      if (err.code === STORAGE.NO_SUCH_FILE_ERROR || err.code === HTTP_STATUS.NOT_FOUND) {
        const manifest = await this.getPackageLocalMetadata(name);
        // const [updatedManifest, errors] = this.syncUplinksMetadataNext(name, manifest, {});
        if (
          _.isNil(err) &&
          manifest._distfiles &&
          _.isNil(manifest._distfiles[filename]) === false
        ) {
          // file exist locally
        } else {
          // we look up at uplinks
          // we try to fetch the latest tarball url
          const tarballUrl = manifest._distfiles[filename];

          try {
            const remoteStream = await this.fetchTarllballFromUpstream(name, tarballUrl);
            return remoteStream;
          } catch (err: any) {
            this.logger.error({ err: err.message }, 'some error on uplink getTarballNext @{err}');
            throw err;
          }
        }

        // throw errorUtils.getNotFound(API_ERROR.NO_SUCH_FILE);
      } else {
        this.logger.error({ err: err.message }, 'some error on fatal @{err}');
        throw err;
      }
    }

    // 1. Falla, actualizar metadata
    // 2. Obtener latest version tarball and append stream
  }

  /**
   Get a tarball from a storage for {name} package
   Function is synchronous and returns a ReadableStream
   Function tries to read tarball locally, if it fails then it reads package
   information in order to figure out where we can get this tarball from
   Used storages: local || uplink (just one)
   */
  public getTarball(name: string, filename: string): IReadTarball {
    debug('get tarball for package %o filename %o', name, filename);
    const readStream = new ReadTarball({});
    readStream.abort = function () {};

    const self = this;

    // if someone requesting tarball, it means that we should already have some
    // information about it, so fetching package info is unnecessary

    // trying local first
    // flow: should be IReadTarball
    let localStream: any = self.localStorage.getTarball(name, filename);
    let isOpen = false;
    localStream.on('error', (err): any => {
      if (isOpen || err.status !== HTTP_STATUS.NOT_FOUND) {
        return readStream.emit('error', err);
      }

      // local reported 404
      const err404 = err;
      localStream.abort();
      localStream = null; // we force for garbage collector
      self.localStorage.getPackageMetadata(name, (err, info: Manifest): void => {
        if (_.isNil(err) && info._distfiles && _.isNil(info._distfiles[filename]) === false) {
          // information about this file exists locally
          serveFile(info._distfiles[filename]);
        } else {
          // we know nothing about this file, trying to get information elsewhere
          self._syncUplinksMetadata(name, info, {}, (err, info: Manifest): any => {
            if (_.isNil(err) === false) {
              return readStream.emit('error', err);
            }
            if (_.isNil(info._distfiles) || _.isNil(info._distfiles[filename])) {
              return readStream.emit('error', err404);
            }
            serveFile(info._distfiles[filename]);
          });
        }
      });
    });
    localStream.on('content-length', function (v): void {
      readStream.emit('content-length', v);
    });

    localStream.on('open', function (): void {
      isOpen = true;
      localStream.pipe(readStream);
    });
    return readStream;

    /**
     * Fetch and cache local/remote packages.
     * @param {Object} file define the package shape
     */
    function serveFile(file: DistFile): void {
      let uplink: any = null;

      for (const uplinkId in self.uplinks) {
        // https://github.com/verdaccio/verdaccio/issues/1642
        if (hasProxyTo(name, uplinkId, self.config.packages)) {
          uplink = self.uplinks[uplinkId];
        }
      }

      if (uplink == null) {
        uplink = new ProxyStorage(
          {
            url: file.url,
            cache: true,
            _autogenerated: true,
          },
          self.config
        );
      }

      let savestream: IUploadTarball | null = null;
      if (uplink.config.cache) {
        savestream = self.localStorage.addTarball(name, filename);
        savestream.on('success', () => {
          debug('tarball %s saved locally', filename);
        });
      }

      let on_open = function (): void {
        // prevent it from being called twice
        on_open = function () {};
        const rstream2 = uplink.fetchTarball(file.url);
        rstream2.on('error', function (err): void {
          if (savestream) {
            savestream.abort();
          }
          savestream = null;
          readStream.emit('error', err);
        });
        rstream2.on('end', function (): void {
          if (savestream) {
            savestream.done();
          }
        });

        rstream2.on('content-length', function (v): void {
          readStream.emit('content-length', v);
          if (savestream) {
            savestream.emit('content-length', v);
          }
        });
        rstream2.pipe(readStream);
        if (savestream) {
          rstream2.pipe(savestream);
        }
      };

      if (savestream) {
        savestream.on('open', function (): void {
          on_open();
        });

        savestream.on('error', function (err): void {
          self.logger.warn(
            { err: err, fileName: file },
            'error saving file @{fileName}: @{err?.message}\n@{err.stack}'
          );
          if (savestream) {
            savestream.abort();
          }
          savestream = null;
          on_open();
        });
      } else {
        on_open();
      }
    }
  }

  // public async starPackage(body: StarBody, options: IGetPackageOptionsNext): Promise<void> {
  //   debug('star package');
  //   const manifest = await this.getPackageNext(options);
  //   const newStarUser = body[constants.USERS];
  //   const remoteUsername: string = options.remoteUser.name as string;
  //   const localStarUsers = manifest[constants.USERS];
  //   // Check is star or unstar
  //   const isStar = Object.keys(newStarUser).includes(remoteUsername);
  //   debug('is start? %o', isStar);
  //   if (
  //     _.isNil(localStarUsers) === false &&
  //     validateInputs(localStarUsers, remoteUsername, isStar)
  //   ) {
  //     // return afterChangePackage();
  //   }
  //   const users: Users = isStar
  //     ? {
  //         ...localStarUsers,
  //         [remoteUsername]: true,
  //       }
  //     : _.reduce(
  //         localStarUsers,
  //         (users, value, key) => {
  //           if (key !== remoteUsername) {
  //             users[key] = value;
  //           }
  //           return users;
  //         },
  //         {}
  //       );
  //   debug('update package for  %o', name);
  // }

  // public async publish(body: any, options: IGetPackageOptionsNext): Promise<any> {
  //   const { name } = options;
  //   debug('publishing or updating a new version for %o', name);
  //   // we check if the request is npm star
  //   if (!isPublishablePackage(body) && isObject(body.users)) {
  //     debug('starting star a package');
  //     await this.starPackage(body as StarBody, options);
  //   }

  //   return { ok: API_MESSAGE.PKG_CHANGED, success: true };
  // }

  public async getPackageByVersion(options: IGetPackageOptionsNext): Promise<Version> {
    const queryVersion = options.version as string;
    if (_.isNil(queryVersion)) {
      throw errorUtils.getNotFound(`${API_ERROR.VERSION_NOT_EXIST}: ${queryVersion}`);
    }

    // we have version, so we need to return specific version
    const [convertedManifest] = await this.getPackageNext(options);

    const version: Version | undefined = getVersion(convertedManifest.versions, queryVersion);

    debug('query by latest version %o and result %o', queryVersion, version);
    if (typeof version !== 'undefined') {
      debug('latest version found %o', version);
      return convertDistVersionToLocalTarballsUrl(
        convertedManifest.name,
        version,
        options.requestOptions,
        this.config.url_prefix
      );
    }

    // the version could be a dist-tag eg: beta, alpha, so we find the matched version
    // on disg-tag list
    if (_.isNil(convertedManifest[DIST_TAGS]) === false) {
      if (_.isNil(convertedManifest[DIST_TAGS][queryVersion]) === false) {
        // the version found as a distag
        const matchedDisTagVersion: string = convertedManifest[DIST_TAGS][queryVersion];
        debug('dist-tag version found %o', matchedDisTagVersion);
        const disTagVersion: Version | undefined = getVersion(
          convertedManifest.versions,
          matchedDisTagVersion
        );
        if (typeof disTagVersion !== 'undefined') {
          debug('dist-tag found %o', disTagVersion);
          return convertDistVersionToLocalTarballsUrl(
            convertedManifest.name,
            disTagVersion,
            options.requestOptions,
            this.config.url_prefix
          );
        }
      }
    } else {
      debug('dist tag not detected');
    }

    // we didn't find the version, not found error
    debug('package version not found %o', queryVersion);
    throw errorUtils.getNotFound(`${API_ERROR.VERSION_NOT_EXIST}: ${queryVersion}`);
  }

  public async getPackageManifest(options: IGetPackageOptionsNext): Promise<Manifest> {
    // convert dist remotes to local bars
    const [manifest] = await this.getPackageNext(options);
    const convertedManifest = convertDistRemoteToLocalTarballUrls(
      manifest,
      options.requestOptions,
      this.config.url_prefix
    );

    return convertedManifest;
  }

  /**
   * Return a manifest or version based on the options.
   * @param options {Object}
   * @returns A package manifest or specific version
   */
  public async getPackageByOptions(options: IGetPackageOptionsNext): Promise<Manifest | Version> {
    // if no version we return the whole manifest
    if (_.isNil(options.version) === false) {
      return this.getPackageByVersion(options);
    } else {
      return this.getPackageManifest(options);
    }
  }

  public async getPackageNext(options: IGetPackageOptionsNext): Promise<[Manifest, any[]]> {
    const { name } = options;
    debug('get package for %o', name);
    let data: Manifest | void;

    try {
      data = await this.getPackageLocalMetadata(name);
    } catch (err: any) {
      // we don't have package locally, so we need to fetch it from uplinks
      if (err && (!err.status || err.status >= HTTP_STATUS.INTERNAL_ERROR)) {
        throw err;
      }
    }

    // time to sync with uplinks if we have any
    debug('sync uplinks for %o', name);
    const [remoteManifest, upLinksErrors] = await this.syncUplinksMetadataNext(
      name,
      data as Manifest,
      {
        uplinksLook: options.uplinksLook,
        remoteAddress: options.requestOptions.remoteAddress,
        // etag??
      }
    );

    if (!remoteManifest && typeof data === 'undefined') {
      throw errorUtils.getNotFound(`${API_ERROR.NOT_PACKAGE_UPLINK}: ${name}`);
    }

    if (!remoteManifest) {
      // no data on uplinks
      return [data as Manifest, upLinksErrors];
    }

    const normalizedPkg = Object.assign({}, remoteManifest, {
      // FIXME: clean up  mutation of cleanUpLinksRef
      ...normalizeDistTags(cleanUpLinksRef(remoteManifest, options.keepUpLinkData)),
      _attachments: {},
    });

    debug('no. sync uplinks errors %o for %s', upLinksErrors?.length, name);
    return [normalizedPkg, upLinksErrors];
  }

  /**
   Retrieve a package metadata for {name} package
   Function invokes localStorage.getPackage and uplink.get_package for every
   uplink with proxy_access rights against {name} and combines results
   into one json object
   Used storages: local && uplink (proxy_access)

   * @param {object} options
   * @property {string} options.name Package Name
   * @property {object}  options.req Express `req` object
   * @property {boolean} options.keepUpLinkData keep up link info in package meta, last update, etc.
   * @property {function} options.callback Callback for receive data
   * @deprecated use await storage.getPackageByOptions
   */
  public getPackage(options: IGetPackageOptions): void {
    const { name } = options;
    debug('get package for %o', name);
    this.localStorage.getPackageMetadata(name, (err, data) => {
      if (err && (!err.status || err.status >= HTTP_STATUS.INTERNAL_ERROR)) {
        // report internal errors right away
        debug('error on get package for %o with error %o', name, err?.message);
        return options.callback(err);
      }

      debug('sync uplinks for %o', name);
      this._syncUplinksMetadata(
        name,
        data,
        { req: options.req, uplinksLook: options.uplinksLook },
        function getPackageSynUpLinksCallback(err, result: Manifest, uplinkErrors): void {
          if (err) {
            debug('error on sync package for %o with error %o', name, err?.message);
            return options.callback(err);
          }

          result = normalizeDistTags(cleanUpLinksRef(result, options?.keepUpLinkData));

          // npm can throw if this field doesn't exist
          result._attachments = {};

          debug('no. sync uplinks errors %o', uplinkErrors?.length);
          options.callback(null, result, uplinkErrors);
        }
      );
    });
  }

  /**
   * Retrieve only private local packages
   * @param {*} callback
   */
  public getLocalDatabase(callback: Callback): void {
    const self = this;
    debug('get local database');
    if (this.localStorage.storagePlugin !== null) {
      this.localStorage.storagePlugin
        .get()
        .then((locals) => {
          const packages: Version[] = [];
          const getPackage = function (itemPkg): void {
            self.localStorage.getPackageMetadata(
              locals[itemPkg],
              function (err, pkgMetadata: Manifest): void {
                if (_.isNil(err)) {
                  const latest = pkgMetadata[DIST_TAGS].latest;
                  if (latest && pkgMetadata.versions[latest]) {
                    const version: Version = pkgMetadata.versions[latest];
                    const timeList = pkgMetadata.time as GenericBody;
                    const time = timeList[latest];
                    // @ts-ignore
                    version.time = time;

                    // Add for stars api
                    // @ts-ignore
                    version.users = pkgMetadata.users;

                    packages.push(version);
                  } else {
                    self.logger.warn(
                      { package: locals[itemPkg] },
                      'package @{package} does not have a "latest" tag?'
                    );
                  }
                }

                if (itemPkg >= locals.length - 1) {
                  callback(null, packages);
                } else {
                  getPackage(itemPkg + 1);
                }
              }
            );
          };

          if (locals.length) {
            getPackage(0);
          } else {
            callback(null, []);
          }
        })
        .catch((err) => {
          callback(err);
        });
    } else {
      debug('local stora instance is null');
    }
  }

  /**
   * Function fetches package metadata from uplinks and synchronizes it with local data
   if package is available locally, it MUST be provided in pkginfo
   returns callback(err, result, uplink_errors)
   @deprecated use syncUplinksMetadataNext
   */
  public _syncUplinksMetadata(
    name: string,
    packageInfo: Manifest,
    options: ISyncUplinks,
    callback: Callback
  ): void {
    let found = true;
    const self = this;
    const upLinks: IProxy[] = [];
    const hasToLookIntoUplinks = _.isNil(options.uplinksLook) || options.uplinksLook;
    debug('is sync uplink enabled %o', hasToLookIntoUplinks);

    if (!packageInfo) {
      found = false;
      packageInfo = generatePackageTemplate(name);
    }

    for (const uplink in this.uplinks) {
      if (hasProxyTo(name, uplink, this.config.packages) && hasToLookIntoUplinks) {
        upLinks.push(this.uplinks[uplink]);
      }
    }

    debug('uplink list %o', upLinks.length);

    async.map(
      upLinks,
      (upLink, cb): void => {
        const _options = Object.assign({}, options);
        const upLinkMeta = packageInfo._uplinks[upLink.upname];

        if (validatioUtils.isObject(upLinkMeta)) {
          const fetched = upLinkMeta.fetched;

          if (fetched && Date.now() - fetched < upLink.maxage) {
            return cb();
          }

          _options.etag = upLinkMeta?.etag;
        }

        upLink.getRemoteMetadata(name, _options, (err, upLinkResponse, eTag): void => {
          if (err && err.remoteStatus === 304) {
            upLinkMeta.fetched = Date.now();
          }

          if (err || !upLinkResponse) {
            return cb(null, [err || errorUtils.getInternalError('no data')]);
          }

          try {
            validatioUtils.validateMetadata(upLinkResponse, name);
          } catch (err: any) {
            self.logger.error(
              {
                sub: 'out',
                err: err,
              },
              'package.json validating error @{!err?.message}\n@{err.stack}'
            );
            return cb(null, [err]);
          }

          packageInfo._uplinks[upLink.upname] = {
            etag: eTag,
            fetched: Date.now(),
          };

          packageInfo.time = mergeUplinkTimeIntoLocal(packageInfo, upLinkResponse);

          updateVersionsHiddenUpLink(upLinkResponse.versions, upLink);

          try {
            pkgUtils.mergeVersions(packageInfo, upLinkResponse);
          } catch (err: any) {
            self.logger.error(
              {
                sub: 'out',
                err: err,
              },
              'package.json parsing error @{!err?.message}\n@{err.stack}'
            );
            return cb(null, [err]);
          }

          // if we got to this point, assume that the correct package exists
          // on the uplink
          found = true;
          cb();
        });
      },
      // @ts-ignore
      (err: Error, upLinksErrors: any): AsyncResultArrayCallback<unknown, Error> => {
        assert(!err && Array.isArray(upLinksErrors));

        // Check for connection timeout or reset errors with uplink(s)
        // (these should be handled differently from the package not being found)
        if (!found) {
          let uplinkTimeoutError;
          for (let i = 0; i < upLinksErrors.length; i++) {
            if (upLinksErrors[i]) {
              for (let j = 0; j < upLinksErrors[i].length; j++) {
                if (upLinksErrors[i][j]) {
                  const code = upLinksErrors[i][j].code;
                  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ECONNRESET') {
                    uplinkTimeoutError = true;
                    break;
                  }
                }
              }
            }
          }

          if (uplinkTimeoutError) {
            return callback(errorUtils.getServiceUnavailable(), null, upLinksErrors);
          }
          return callback(errorUtils.getNotFound(API_ERROR.NO_PACKAGE), null, upLinksErrors);
        }

        if (upLinks.length === 0) {
          return callback(null, packageInfo);
        }

        self.localStorage.updateVersions(
          name,
          packageInfo,
          async (err, packageJsonLocal: Manifest): Promise<any> => {
            if (err) {
              return callback(err);
            }
            // Any error here will cause a 404, like an uplink error. This is likely
            // the right thing to do
            // as a broken filter is a security risk.
            const filterErrors: Error[] = [];
            // This MUST be done serially and not in parallel as they modify packageJsonLocal
            for (const filter of self.filters) {
              try {
                // These filters can assume it's save to modify packageJsonLocal
                // and return it directly for
                // performance (i.e. need not be pure)
                packageJsonLocal = await filter.filter_metadata(packageJsonLocal);
              } catch (err: any) {
                filterErrors.push(err);
              }
            }
            callback(null, packageJsonLocal, _.concat(upLinksErrors, filterErrors));
          }
        );
      }
    );
  }
}

export { Storage };
