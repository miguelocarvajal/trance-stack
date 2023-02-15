import type { EntryContext } from '@remix-run/node';
import { PassThrough } from 'stream';
import { RemixServer } from '@remix-run/react';
import { renderToPipeableStream, renderToString } from 'react-dom/server';
import { createUserSession } from '~/session.server';
import { initServerI18n } from '~/i18n';
import { I18nextProvider } from 'react-i18next';
import { contentSecurityPolicy } from '~/utils/contentSecurityPolicy';
import isbot from 'isbot';
import { Response } from '@remix-run/node';

const ABORT_DELAY = 5000;

export default async (
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  remixContext: EntryContext
) => {
  const handoffData = JSON.parse(remixContext.serverHandoffString || '{}');
  // access data from root loader
  const { locale /* , user, flags, session */ } = handoffData.state.loaderData.root || { locale: 'en' };

  // initialise stuff in parallel
  const [i18nextInstance] = await Promise.all([
    initServerI18n(locale, remixContext)
  ]);
  const cookie = await createUserSession(request);
  const isDevelopment = process.env.NODE_ENV === 'development';

  const callbackName = isbot(request.headers.get('user-agent')) ? 'onAllReady' : 'onShellReady';

  return new Promise((resolve, reject) => {
    let didError = false;
    const { pipe, abort } = renderToPipeableStream(
      <I18nextProvider i18n={i18nextInstance}>
        <RemixServer context={remixContext} url={request.url}/>
      </I18nextProvider>,
      {
        [callbackName]: function () {
          const body = new PassThrough();
          const output = new PassThrough();

          responseHeaders.set('Content-Type', 'text/html');

          // OWASP headers
          responseHeaders.set('X-Frame-Options', 'SAMEORIGIN');
          responseHeaders.set(
            'Content-Security-Policy',
            contentSecurityPolicy(isDevelopment)
          );
          responseHeaders.set('X-Content-Type-Options', 'nosniff');
          responseHeaders.set('X-Permitted-Cross-Domain-Policies', 'none');
          responseHeaders.set('Referrer-Policy', 'origin-when-cross-origin');
          responseHeaders.set('X-XSS-Protection', '0');
          responseHeaders.set('Set-Cookie', cookie);

          resolve(
            new Response(output, {
              status: didError ? 500 : responseStatusCode,
              headers: responseHeaders
            })
          );

          pipe(body).pipe(output);
        },
        onShellError: function (err: unknown) {
          reject(err);
        },
        onError: function (error: unknown) {
          didError = true;
          console.error(error);
        }
      }
    );
    setTimeout(abort, ABORT_DELAY);
  });

  // const markup = renderToString(
  //   <RemixServer context={remixContext} url={request.url} />
  // );
  //
  // responseHeaders.set('Content-Type', 'text/html');
  // responseHeaders.set('Set-Cookie', await createUserSession(request));
  //
  // return new Response('<!DOCTYPE html>' + markup, {
  //   headers: responseHeaders,
  //   status: responseStatusCode
  // });
};

export const handleDataRequest = (
  response: Response,
  { request }: { request: Request }
) => {
  // Cache all loader responses on the browser for 10mins, unless overridden in the loader
  if (
    !response.headers.get('Cache-Control')
    && request.method.toLowerCase() === 'get'
  ) {
    response.headers.set('Cache-Control', 'private, max-age=600');
  }
  return response;
};
