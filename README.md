# Meta Multi-Page Publisher Starter

This starter uses Meta's official OAuth/Graph API flow. It does not bypass permissions or Page ownership.

## Run
1. Install Node.js LTS.
2. Copy `.env.example` to `.env`.
3. Fill in Meta App ID, App Secret, Graph API version, and redirect URI.
4. In Meta Developer Dashboard configure the OAuth redirect URI: `http://localhost:3000/auth/meta/callback`.
5. `npm install`
6. `npm start`
7. Open `http://localhost:3000`.

For a production multi-owner service, add a database, encrypted token storage, CSRF/state protection, HTTPS, job queue, rate-limit handling, token lifecycle handling, audit logs, and required Meta App Review/Business requirements.
