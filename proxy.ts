import { NextResponse, type NextRequest } from 'next/server';

const REALM = 'Ark Internal';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function unauthorized(): Response {
  return new Response('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export function proxy(request: NextRequest): Response | undefined {
  const { pathname } = request.nextUrl;
  if (pathname === '/api/health') return;

  const expected = process.env.CHATBOT_PASSWORD;
  const username = process.env.CHATBOT_USERNAME || 'team';
  if (!expected) {
    return new Response('Server misconfigured: CHATBOT_PASSWORD not set.', {
      status: 500,
    });
  }

  const header = request.headers.get('authorization');
  if (!header || !header.toLowerCase().startsWith('basic ')) {
    return unauthorized();
  }

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
  } catch {
    return unauthorized();
  }

  const sep = decoded.indexOf(':');
  if (sep < 0) return unauthorized();

  const providedUser = decoded.slice(0, sep);
  const providedPass = decoded.slice(sep + 1);
  if (!timingSafeEqual(providedUser, username) || !timingSafeEqual(providedPass, expected)) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
