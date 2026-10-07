// The code-entry page and its assets (decision 5: the page is served by
// the service). Script and style are separate files because the CSP is
// script-src 'self' with no inline code (contract: Security headers).
// The page has two stages: ask for the email address, then ask for the
// code. The challenge id lives only in page memory, never in the URL.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main>
  <h1>Sign in with email</h1>
  <form id="address-form" autocomplete="off">
    <label for="address">Email address</label>
    <input id="address" name="address" type="email" required>
    <button type="submit">Send code</button>
  </form>
  <form id="code-form" autocomplete="off" hidden>
    <label for="code">Six-digit code</label>
    <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}"
           maxlength="6" required>
    <button type="submit">Continue</button>
  </form>
  <p id="message" role="status"></p>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

// Stage 1 posts the address to the service, which mails a code and sets
// a host-only SameSite=Strict cookie binding the challenge to this
// browser. Stage 2 checks the code and carries the signed proof to the
// app through a bounded exchange (contract: Callback protocol, option
// 2). The proof travels only in a request body, never in a URL, and the
// final navigation carries no token at all.
export const PAGE_JS = `(() => {
  const params = new URLSearchParams(location.search);
  const appOrigin = params.get('app') || '';
  const stateId = params.get('state') || '';
  const addressForm = document.getElementById('address-form');
  const codeForm = document.getElementById('code-form');
  const message = document.getElementById('message');
  let challengeId = '';
  let address = '';

  addressForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    address = document.getElementById('address').value;
    try {
      const res = await fetch('/v1/challenges', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, appOrigin, stateId }),
      });
      const data = await res.json();
      // Same message either way: the response never says whether the
      // address is on the list (R3).
      challengeId = data.challengeId || '';
      addressForm.hidden = true;
      codeForm.hidden = false;
      message.textContent = 'If we can sign you in, a code is on its way.';
    } catch {
      message.textContent = 'Something went wrong. Please try again.';
    }
  });

  codeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    try {
      const res = await fetch('/v1/challenges/' + encodeURIComponent(challengeId) + '/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: document.getElementById('code').value, address }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        message.textContent = 'That code did not work. Check it and try again.';
        return;
      }
      const exchange = await fetch(data.callbackUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proof: data.proof, state: data.state }),
      });
      if (!exchange.ok) {
        message.textContent = 'Sign-in failed. Please start again.';
        return;
      }
      const done = await exchange.json();
      location.assign(done.completeUrl);
    } catch {
      message.textContent = 'Something went wrong. Please try again.';
    }
  });
})();
`;

export const PAGE_CSS = `body { font-family: -apple-system, system-ui, sans-serif; margin: 0; }
main { max-width: 22rem; margin: 4rem auto; padding: 0 1rem; }
label { display: block; margin-bottom: 0.5rem; }
input { font-size: 1.25rem; width: 100%; box-sizing: border-box; }
#code { letter-spacing: 0.5rem; }
button { margin-top: 1rem; font-size: 1rem; padding: 0.5rem 1rem; }
#message { min-height: 1.5rem; }
`;
