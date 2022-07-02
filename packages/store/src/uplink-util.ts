import { IProxy, ProxyStorage } from '@verdaccio/proxy';
import { Config, Manifest, Versions } from '@verdaccio/types';

export interface ProxyInstanceList {
  [key: string]: IProxy;
}

/**
 * Set up the Up Storage for each link.
 */
export function setupUpLinks(config: Config): ProxyInstanceList {
  const uplinks: ProxyInstanceList = {};

  for (const uplinkName in config.uplinks) {
    if (Object.prototype.hasOwnProperty.call(config.uplinks, uplinkName)) {
      // instance for each up-link definition
      const proxy: IProxy = new ProxyStorage(config.uplinks[uplinkName], config);
      // TODO: review this can be inside ProxyStorage
      proxy.upname = uplinkName;

      uplinks[uplinkName] = proxy;
    }
  }

  return uplinks;
}

// @deprecated
export function updateVersionsHiddenUpLink(versions: Versions, upLink: IProxy): void {
  for (const i in versions) {
    if (Object.prototype.hasOwnProperty.call(versions, i)) {
      const version = versions[i];

      // holds a "hidden" value to be used by the package storage.
      version[Symbol.for('__verdaccio_uplink')] = upLink.upname;
    }
  }
}

export function updateVersionsHiddenUpLinkNext(manifest: Manifest, upLink: IProxy): Manifest {
  const { versions } = manifest;
  const versionsList = Object.keys(versions);
  if (versionsList.length === 0) {
    return manifest;
  }

  for (const version of versionsList) {
    // holds a "hidden" value to be used by the package storage.
    versions[version][Symbol.for('__verdaccio_uplink')] = upLink.upname;
  }

  return { ...manifest, versions: versions };
}
