import { isNil } from '@medishn/toolkit';
import { HttpContext, HttpHeaderValue, SettingsOptions } from '../../../interface';
import { EntityTagAlgorithm, EntityTagStrength, GlandMiddleware } from '../../../types';
import { AbstractConfigChannel } from '../config-channel';
import { ConfigChannel } from '../..';
import { generateETag } from '../utils';

export class SettingsChannel extends AbstractConfigChannel<SettingsOptions, 'settings'> {
  private readonly strength: EntityTagStrength;
  private readonly algorithm: EntityTagAlgorithm;
  constructor(channel: ConfigChannel) {
    super(channel, 'settings');
    this.strength = this.get('etag')?.strength ?? 'strong';
    this.algorithm = this.get('etag')?.algorithm ?? 'sha256';
  }

  createMiddleware(): GlandMiddleware {
    return async (ctx, next) => {
      if (this.get('poweredBy')) {
        ctx.header.set('x-powered-by', this.get('poweredBy'));
      }
      ctx.subdomains = this._getSubdomains(ctx);

      const clientValidation = {
        etag: ctx.header.get('if-none-match'),
        modifiedSince: ctx.header.get('if-modified-since'),
      };

      await next();

      if (this.shouldProcessValidation(ctx)) {
        this.handleCacheValidation(ctx, clientValidation);
      }
    };
  }

  private handleCacheValidation(
    ctx: HttpContext,
    clientValidation: {
      etag: HttpHeaderValue<any, any> | undefined;
      modifiedSince: HttpHeaderValue<any, any> | undefined;
    },
  ) {
    // Generate ETag from response body
    const serverETag = generateETag(ctx.body, this.algorithm, this.strength);
    ctx.header.set('etag', serverETag);

    // ETag validation
    if (clientValidation.etag) {
      const clientETags = clientValidation.etag
        .toString()
        .split(',')
        .map((t) => t.trim());
      if (this.anyETagMatches(clientETags, serverETag)) {
        this.sendNotModified(ctx);
        return;
      }
    }

    // Last-Modified validation
    if (clientValidation.modifiedSince) {
      const lastModifiedHeader = ctx.header.get('last-modified');
      if (lastModifiedHeader) {
        const lastModified = this.parseDate(lastModifiedHeader.toString());
        const modifiedSince = this.parseDate(clientValidation.modifiedSince.toString());

        if (lastModified && modifiedSince && lastModified <= modifiedSince) {
          this.sendNotModified(ctx);
          return;
        }
      }
    }
  }

  private anyETagMatches(clientETags: string[], serverETag: string): boolean {
    return clientETags.some((clientETag) => {
      if (clientETag === '*') return true;
      return this.normalizeETag(clientETag) === this.normalizeETag(serverETag);
    });
  }

  private sendNotModified(ctx: HttpContext): void {
    ctx.status = 304;
    ctx.body = null;
    ctx.header.remove('content-type');
    ctx.header.remove('content-length');
  }
  private normalizeETag(etag: string): string {
    return etag.replace(/^W\//i, '').replace(/"/g, '');
  }

  private parseDate(dateString: string): Date | null {
    const date = new Date(dateString);
    return isNaN(date.getTime()) ? null : date;
  }

  /**
   * Compare client and server ETags for equality, handling weak/strong tags
   */
  public compareETags(clientETag: string, serverETag: string): boolean {
    if (!clientETag || !serverETag) return false;

    if (clientETag === '*') return true;

    if (clientETag.includes(',')) {
      return clientETag
        .split(',')
        .map((tag) => tag.trim())
        .some((tag) => this.compareETags(tag, serverETag));
    }

    return this.normalize(clientETag) === this.normalize(serverETag);
  }

  /**
   * Normalize an ETag by removing quotes and W/ prefix
   */
  private normalize(etag: string): string {
    return etag.replace(/^W\//, '').replace(/"/g, '');
  }

  private shouldProcessValidation(ctx: HttpContext): boolean {
    return (ctx.method === 'GET' || ctx.method === 'HEAD') && ctx.status >= 200 && ctx.status < 300 && ctx.body && !ctx.header.get('etag');
  }

  private _getSubdomains(ctx: HttpContext) {
    const host = ctx.host;

    if (isNil(host)) {
      return [];
    }
    const hostname = host.split(':')[0];
    if (this._isIPAddress(hostname)) {
      return [];
    }

    const offset = this.get('subdomainOffset')!;

    const segments = hostname.split('.');

    const subdomains = segments.slice(0, segments.length - offset);
    return subdomains.reverse();
  }
  /**
   * Helper method to check if a string is an IP address
   */
  private _isIPAddress(str: string): boolean {
    // IPv4 check
    const ipv4Regex = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    if (ipv4Regex.test(str)) {
      const parts = str.split('.').map((part) => parseInt(part, 10));
      return parts.every((part) => part >= 0 && part <= 255);
    }

    // IPv6 check (simplified)
    const ipv6Regex = /^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
    return ipv6Regex.test(str);
  }
}
