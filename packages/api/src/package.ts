import buildDebug from 'debug';
import { Router } from 'express';
import { pipeline } from 'stream/promises';

import { IAuth } from '@verdaccio/auth';
import { HEADERS, HEADER_TYPE, errorUtils } from '@verdaccio/core';
import { allow } from '@verdaccio/middleware';
import { Storage } from '@verdaccio/store';

import { $NextFunctionVer, $RequestExtend, $ResponseExtend } from '../types/custom';

const debug = buildDebug('verdaccio:api:package');

const downloadStream = (
  packageName: string,
  filename: string,
  storage: any,
  _req: $RequestExtend,
  res: $ResponseExtend
): void => {
  const stream = storage.getTarball(packageName, filename);

  stream.on('content-length', function (content): void {
    res.header('Content-Length', content);
  });

  stream.on('error', function (err): void {
    return res.locals.report_error(err);
  });

  res.header(HEADERS.CONTENT_TYPE, HEADERS.OCTET_STREAM);
  stream.pipe(res);
};

export default function (route: Router, auth: IAuth, storage: Storage): void {
  const can = allow(auth);

  route.get(
    '/:package/:version?',
    can('access'),
    async function (
      req: $RequestExtend,
      _res: $ResponseExtend,
      next: $NextFunctionVer
    ): Promise<void> {
      debug('init package by version');
      const name = req.params.package;
      let queryVersion = req.params.version;
      const write = req.query.write === 'true';
      const requestOptions = {
        protocol: req.protocol,
        headers: req.headers as any,
        // FIXME: if we migrate to req.hostname, the port is not longer included.
        host: req.host,
        remoteAddress: req.socket.remoteAddress,
        byPassCache: write,
      };

      try {
        // TODO: this is just temporary while I migrate all plugins to use the new API
        // the method will be renamed to getPackage again but Promise Based.
        if (!storage.getPackageByOptions) {
          throw errorUtils.getInternalError(
            'getPackageByOptions not implemented, check pr-2750 for more details'
          );
        }

        const manifest = await storage.getPackageByOptions({
          name,
          uplinksLook: true,
          // remove on refactor getPackageByOptions
          // @ts-ignore
          req,
          version: queryVersion,
          requestOptions,
        });
        next(manifest);
      } catch (err) {
        next(err);
      }
    }
  );

  // route.get(
  //   '/:scopedPackage/-/:scope/:filename',
  //   can('access'),
  //   function (req: $RequestExtend, res: $ResponseExtend): void {
  //     const { scopedPackage, filename } = req.params;

  //     downloadStream(scopedPackage, filename, storage, req, res);
  //   }
  // );

  route.get(
    '/:package/-/:filename',
    can('access'),
    function (req: $RequestExtend, res: $ResponseExtend): void {
      downloadStream(req.params.package, req.params.filename, storage, req, res);
    }
  );

  route.get(
    '/new/:pkg/-/:filename',
    can('access'),
    async function (req: $RequestExtend, res: $ResponseExtend, next): Promise<void> {
      const { pkg, filename } = req.params;
      const abort = new AbortController();
      try {
        const stream = (await storage.getTarballNext(pkg, filename, {
          signal: abort.signal,
          enableRemote: true,
        })) as any;

        stream.on('content-length', (size) => {
          res.header(HEADER_TYPE.CONTENT_LENGTH, size);
        });

        req.on('aborted', () => {
          debug('search web aborted');
          abort.abort();
        });

        await pipeline(stream, res, { signal: abort.signal });
      } catch (err: any) {
        console.log('error request', err);
        res.locals.report_error(err);
        next(err);
      }
    }
  );
}
