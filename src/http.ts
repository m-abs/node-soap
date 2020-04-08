/*
 * Copyright (c) 2011 Vinay Pulim <vinay@milewise.com>
 * MIT Licensed
 */

import { fetch, Headers } from 'cross-fetch';
import * as debugBuilder from 'debug';
import * as createHttpError from 'http-errors';
import * as ntlm from 'httpntlm/ntlm';
import * as _ from 'lodash';
import { PassThrough } from 'stream';
import * as url from 'url';
import * as uuid from 'uuid/v4';
import { IHeaders, IOptions, IRequestHandler, IRequestParam, IResponse } from './types';

const debug = debugBuilder('node-soap');
const VERSION = require('../package.json').version;

export interface IExOptions {
  [key: string]: any;
}

export interface IAttachment {
  name: string;
  contentId: string;
  mimetype: string;
  body: NodeJS.ReadableStream;
}

function requestWrapper(options: RequestInit & { uri: string }, callback: (err: any, response?: any, body?: any) => void) {
  const uri = options.uri;
  const fetchOptions = Object.assign({}, options);
  delete fetchOptions.uri;

  const headers = {} as IHeaders;

  const fetchHeaders = new Headers(options.headers);
  fetchHeaders.forEach((value, key) => headers[key] = value);

  const start = Date.now();

  fetch(uri, fetchOptions)
    .then((response: IResponse) => {
      response.statusCode = response.status;
      response.statusMessage = response.statusText;
      response.elapsedTime = Date.now() - start;
      response.requestHeaders = headers;
      response.responseHeaders = {};

      response.headers.forEach((value, key) => response.responseHeaders[key] = value);

 /*      if (!response.ok) {
        const err = createHttpError(response.status, response);
        callback(err, response);
        return;
      } */

      callback(null, response, response.body);
    })
    .catch((err) => {
      callback(err);
    });

  return {
    headers,
  };
}

/**
 * A class representing the http client
 * @param {Object} [options] Options object. It allows the customization of
 * `request` module
 *
 * @constructor
 */
export class HttpClient {
  private _request: IRequestHandler;

  constructor(options?: IOptions) {
    options = options || {};
    this._request = options.request || requestWrapper;
  }

  /**
   * Build the HTTP request (method, uri, headers, ...)
   * @param {String} rurl The resource url
   * @param {Object|String} data The payload
   * @param {Object} exheaders Extra http headers
   * @param {Object} exoptions Extra options
   * @returns {Object} The http request object for the `request` module
   */
  public buildRequest(rurl: string, data: any, exheaders?: IHeaders, exoptions: IExOptions = {}): IRequestParam {
    const curl = url.parse(rurl);
    const secure = curl.protocol === 'https:';
    const host = curl.hostname;
    const port = parseInt(curl.port, 10);
    const path = [curl.pathname || '/', curl.search || '', curl.hash || ''].join('');
    const method = data ? 'POST' : 'GET';
    const headers = new Headers({
      'User-Agent': 'node-soap/' + VERSION,
      'Accept': 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      'Accept-Encoding': 'none',
      'Accept-Charset': 'utf-8',
      'Connection': exoptions.forever ? 'keep-alive' : 'close',
      'Host': host + (isNaN(port) ? '' : ':' + port),
    });
    const mergeOptions = ['headers'];
    const attachments: IAttachment[] = exoptions.attachments || [];

    if (typeof data === 'string' && attachments.length === 0 && !exoptions.forceMTOM) {
      headers.set('Content-Length', Buffer.byteLength(data, 'utf8') + '');
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
    }

    exheaders = exheaders || {};
    for (const attr in exheaders) {
      headers.set(attr, exheaders[attr]);
    }

    const options: IRequestParam = {
      uri: rurl,
      method: method,
      headers: headers,
      redirect: 'follow',
    };

    if (exoptions.forceMTOM || attachments.length > 0) {
      const start = uuid();
      let action = null;
      let contentType = headers.get('content-type');
      if (contentType.indexOf('action') > -1) {
           for (const ct of contentType.split('; ')) {
               if (ct.indexOf('action') > -1) {
                    action = ct;
               }
           }
      }

      contentType =
        'multipart/related; type="application/xop+xml"; start="<' + start + '>"; start-info="text/xml"; boundary=' + uuid();
      if (action) {
        contentType = contentType + '; ' + action;
      }

      headers.set('Content-Type', contentType);

      const multipart: any[] = [{
        'Content-Type': 'application/xop+xml; charset=UTF-8; type="text/xml"',
        'Content-ID': '<' + start + '>',
        'body': data,
      }];

      attachments.forEach((attachment) => {
        multipart.push({
          'Content-Type': attachment.mimetype,
          'Content-Transfer-Encoding': 'binary',
          'Content-ID': '<' + attachment.contentId + '>',
          'Content-Disposition': 'attachment; filename="' + attachment.name + '"',
          'body': attachment.body,
        });
      });
      options.multipart = multipart;
    } else {
      options.body = data;
    }

    for (const attr in _.omit(exoptions, ['attachments'])) {
      if (mergeOptions.indexOf(attr) !== -1) {
        for (const header in exoptions[attr]) {
          options[attr][header] = exoptions[attr][header];
        }
      } else {
        options[attr] = exoptions[attr];
      }
    }
    debug('Http request: %j', options);
    return options;
  }

  /**
   * Handle the http response
   * @param {Object} The req object
   * @param {Object} res The res object
   * @param {Object} body The http body
   * @param {Object} The parsed body
   */
  public handleResponse(req: Request, res: Response, body: any) {
    debug('Http response body: %j', body);
    if (typeof body === 'string') {
      // Remove any extra characters that appear before or after the SOAP
      // envelope.
      const match =
        body.replace(/<!--[\s\S]*?-->/, '').match(/(?:<\?[^?]*\?>[\s]*)?<([^:]*):Envelope([\S\s]*)<\/\1:Envelope>/i);
      if (match) {
        body = match[0];
      }
    }
    return body;
  }

  public request(
    rurl: string,
    data: any,
    _callback: (error: any, res?: IResponse, body?: any) => any,
    exheaders?: IHeaders,
    exoptions?: IExOptions,
    caller?,
  ): {
    headers: IHeaders;
  } {
    _callback = _.once(_callback);

    const callback = (error: any, res?: IResponse, body?: any) => {
      if (error) {
        _callback(error, res, body);

        return;
      }

      if (typeof body === 'string') {
        _callback(null, res, this.handleResponse(null, res, body));

        return;
      }

      res.text()
        .catch((err) => _callback(err, res))
        .then((text) => _callback(null, res, this.handleResponse(null, res, text)));
    };

    const options = this.buildRequest(rurl, data, exheaders, exoptions);
    let req: {
      headers: IHeaders;
    };

    if (exoptions !== undefined && exoptions.hasOwnProperty('ntlm')) {
      // sadly when using ntlm nothing to return
      // Not sure if this can be handled in a cleaner way rather than an if/else,
      // will to tidy up if I get chance later, patches welcome - insanityinside
      // TODO - should the following be uri?
      this.ntlmHandshake(rurl, options)
        .then((auth) => {
          const headers = new Headers(options.headers);
          headers.set('Authorization', auth);
          const ntlmOptions = Object.assign({}, options, {headers});

          this._request(ntlmOptions, callback);
        })
        .catch((err) => callback(err));
    } else {
      req = this._request(options, callback);
    }

    return req;
  }

  public requestStream(rurl: string, data: any, exheaders?: IHeaders, exoptions?: IExOptions, caller?): PassThrough {
    const options = this.buildRequest(rurl, data, exheaders, exoptions);

    const stream = new PassThrough();
    this._request(options, (err, response, body) => {
      if (err) {
        stream.emit('error', err);
        return;
      }

      if (body instanceof PassThrough) {
        body.pipe(stream);
      }
    });

    return stream;
  }

  private ntlmHandshake(rurl: string, authOpts: IExOptions) {
    return fetch(rurl, {
      headers: {
        Connection: 'keep-alive',
        Authorization: ntlm.createType1Message(authOpts),
      },
    })
    .then((response) => response.headers.get('www-authenticate'))
    .then((auth) => {
      if (!auth) {
        throw new Error('Stage 1 NTLM handshake failed.');
      }

      return ntlm.createType3Message(ntlm.parseType2Message(auth), authOpts);
    });
  }
}
