```javascript
const APP_NAME = "Meta Multi Page Publisher";

export default {
  async fetch(request, env) {
    try {
      await ensureDatabaseSchema(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

      // Public login endpoint only
      if (request.method === "GET" && path === "/login") {
        if (await isAuthenticated(request, env)) {
          return Response.redirect(`${url.origin}/`, 302);
        }
        return showLoginPage("");
      }

      if (request.method === "POST" && path === "/login") {
        return handleLogin(request, env);
      }

      // Everything else is protected
      if (!(await isAuthenticated(request, env))) {
        return showLoginPage("");
      }

      if (request.method === "GET" && path === "/") {
        return showDashboard(env);
      }

      if (request.method === "GET" && path === "/auth/meta") {
        return startMetaLogin(request, env);
      }

      if (request.method === "GET" && path === "/auth/meta/callback") {
        return metaCallback(request, env);
      }

      if (request.method === "POST" && path === "/sync") {
        return syncPages(request, env);
      }

      if (request.method === "POST" && path === "/remove-account") {
        return removeAccount(request, env);
      }

      if (request.method === "POST" && path === "/publish") {
        return publishPost(request, env);
      }

      if (request.method === "POST" && path === "/logout") {
        return handleLogout();
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

      return page(
        "Error",
        `
        <div class="error-box">
          <h2>Something went wrong</h2>
          <pre>${escapeHtml(
            error?.stack || error?.message || String(error)
          )}</pre>
          <a class="back-btn" href="/">Back to Dashboard</a>
        </div>
        `
      );
    }
  },
};

/* =========================================================
   PASSWORD AUTHENTICATION
   ========================================================= */

async function isAuthenticated(request, env) {
  const configuredPassword = String(
    env.PUBLISHER_PASSWORD || ""
  ).trim();

  if (!configuredPassword) {
    throw new Error(
      "PUBLISHER_PASSWORD secret is missing. Add it in Cloudflare Worker > Settings > Variables and Secrets."
    );
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = parseCookies(cookieHeader);
  const authCookie = cookies.mp_auth;

  if (!authCookie) {
    return false;
  }

  const expected = await createAuthToken(configuredPassword);

  return safeEqual(authCookie, expected);
}

async function createAuthToken(password) {
  const data = new TextEncoder().encode(
    `meta-multi-page-publisher:${password}`
  );

  const hash = await crypto.subtle.digest("SHA-256", data);

  return arrayBufferToHex(hash);
}

function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

function parseCookies(header) {
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function showLoginPage(errorMessage) {
  return page(
    "Password Required",
    `
    <div class="login-wrapper">
      <div class="login-card">
        <div class="login-icon">🔐</div>

        <h1>${APP_NAME}</h1>

        <p class="login-subtitle">
          Enter the password to access the publisher.
        </p>

        ${
          errorMessage
            ? `
          <div class="login-error">
            ${escapeHtml(errorMessage)}
          </div>
          `
            : ""
        }

        <form method="POST" action="/login">
          <div class="field">
            <label for="password">Password</label>

            <input
              id="password"
              name="password"
              type="password"
              placeholder="Enter password"
              autocomplete="current-password"
              autofocus
              required
            />
          </div>

          <button class="login-btn" type="submit">
            Enter Publisher
          </button>
        </form>
      </div>
    </div>
    `
  );
}

async function handleLogin(request, env) {
  const configuredPassword = String(
    env.PUBLISHER_PASSWORD || ""
  ).trim();

  if (!configuredPassword) {
    return showLoginPage(
      "PUBLISHER_PASSWORD secret is not configured."
    );
  }

  const form = await request.formData();
  const password = String(form.get("password") || "");

  if (!password || password !== configuredPassword) {
    return showLoginPage("Incorrect password. Please try again.");
  }

  const token = await createAuthToken(configuredPassword);

  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie":
        `mp_auth=${token}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  });
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/login",
      "Set-Cookie":
        "mp_auth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store",
    },
  });
}

/* =========================================================
   DATABASE
   ========================================================= */

async function ensureDatabaseSchema(db) {
  if (!db) {
    throw new Error(
      "D1 database binding DB is missing. Check wrangler.toml and Cloudflare Worker Bindings."
    );
  }

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        facebook_user_id TEXT NOT NULL UNIQUE,
        account_name TEXT,
        access_token TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
      `
    )
    .run();

  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        facebook_page_id TEXT NOT NULL UNIQUE,
        page_name TEXT,
        access_token TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      )
      `
    )
    .run();

  await db
    .prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_pages_account_id
      ON pages(account_id)
      `
    )
    .run();

  await db
    .prepare(
      `
      CREATE INDEX IF NOT EXISTS idx_pages_page_id
      ON pages(facebook_page_id)
      `
    )
    .run();
}

/* =========================================================
   META CONFIG
   ========================================================= */

function getMetaConfig(env) {
  const appId = String(env.META_APP_ID || "").trim();
  const appSecret = String(env.META_APP_SECRET || "").trim();
  const graphVersion = String(
    env.META_GRAPH_VERSION || ""
  ).trim();

  const missing = [];

  if (!appId) {
    missing.push("META_APP_ID");
  }

  if (!appSecret) {
    missing.push("META_APP_SECRET");
  }

  if (!graphVersion) {
    missing.push("META_GRAPH_VERSION");
  }

  if (missing.length > 0) {
    throw new Error(
      `Meta configuration is missing: ${missing.join(
        ", "
      )}. Check Cloudflare Worker > Settings > Variables and Secrets.`
    );
  }

  return {
    appId,
    appSecret,
    graphVersion,
  };
}

/* =========================================================
   DASHBOARD
   ========================================================= */

async function showDashboard(env) {
  const accountsResult = await env.DB.prepare(
    `
    SELECT
      id,
      facebook_user_id,
      account_name,
      created_at
    FROM accounts
    ORDER BY id ASC
    `
  ).all();

  const accounts = accountsResult.results || [];

  const pagesResult = await env.DB.prepare(
    `
    SELECT
      id,
      facebook_page_id,
      page_name,
      account_id
    FROM pages
    ORDER BY account_id ASC, page_name COLLATE NOCASE ASC
    `
  ).all();

  const pages = pagesResult.results || [];

  const groupedPages = {};

  for (const account of accounts) {
    groupedPages[account.id] = [];
  }

  for (const p of pages) {
    if (!groupedPages[p.account_id]) {
      groupedPages[p.account_id] = [];
    }

    groupedPages[p.account_id].push(p);
  }

  let accountHtml = "";

  if (accounts.length === 0) {
    accountHtml = `
      <div class="empty-box">
        <h3>No Facebook account connected</h3>
        <p>Connect your Facebook account to load your Pages.</p>
      </div>
    `;
  } else {
    for (const account of accounts) {
      const accountPages =
        groupedPages[account.id] || [];

      accountHtml += `
        <section class="account-card">
          <div class="account-header">
            <div>
              <h2>
                ${escapeHtml(
                  account.account_name || "Facebook Account"
                )}
              </h2>

              <div class="facebook-id">
                Facebook ID:
                <code>${escapeHtml(
                  account.facebook_user_id
                )}</code>
              </div>

              <div class="page-count">
                ${accountPages.length}
                Connected Page${
                  accountPages.length === 1 ? "" : "s"
                }
              </div>
            </div>

            <div class="account-actions">
              <form method="POST" action="/sync">
                <input
                  type="hidden"
                  name="account_id"
                  value="${account.id}"
                />

                <button
                  class="btn btn-blue"
                  type="submit"
                >
                  Sync Pages
                </button>
              </form>

              <form
                method="POST"
                action="/remove-account"
                onsubmit="return confirm('Remove this Facebook account and all its connected Pages?');"
              >
                <input
                  type="hidden"
                  name="account_id"
                  value="${account.id}"
                />

                <button
                  class="btn btn-red"
                  type="submit"
                >
                  Remove
                </button>
              </form>
            </div>
          </div>

          <div class="pages-section">
            ${
              accountPages.length > 0
                ? `
              <div class="list-toolbar">
                <strong>Select Pages</strong>

                <div class="select-actions">
                  <button
                    type="button"
                    class="small-btn"
                    onclick="selectAccountPages(${account.id}, true)"
                  >
                    Select All
                  </button>

                  <button
                    type="button"
                    class="small-btn"
                    onclick="selectAccountPages(${account.id}, false)"
                  >
                    Unselect All
                  </button>
                </div>
              </div>

              <div class="page-list">
                ${accountPages
                  .map(
                    (p) => `
                    <label
                      class="page-row"
                      data-account="${account.id}"
                    >
                      <input
                        class="page-checkbox account-${account.id}"
                        type="checkbox"
                        name="page_ids"
                        value="${escapeHtml(p.id)}"
                        data-page-id="${escapeHtml(
                          p.facebook_page_id
                        )}"
                        data-page-name="${escapeHtml(
                          p.page_name || ""
                        )}"
                        form="publish-form"
                      />

                      <div class="page-check"></div>

                      <div class="page-info">
                        <div class="page-name">
                          ${escapeHtml(
                            p.page_name || "Unnamed Page"
                          )}
                        </div>

                        <div class="page-id">
                          Page ID:
                          <code>${escapeHtml(
                            p.facebook_page_id
                          )}</code>
                        </div>
                      </div>
                    </label>
                  `
                  )
                  .join("")}
              </div>
              `
                : `
              <div class="no-pages">
                No Pages found for this account.
                Click <strong>Sync Pages</strong> to refresh.
              </div>
              `
            }
          </div>
        </section>
      `;
    }
  }

  return page(
    APP_NAME,
    `
    <div class="topbar">
      <div>
        <div class="brand">${APP_NAME}</div>

        <div class="subtitle">
          Publish to multiple Facebook Pages
        </div>
      </div>

      <div class="topbar-actions">
        <a class="connect-btn" href="/auth/meta">
          + Connect Facebook Account
        </a>

        <form method="POST" action="/logout">
          <button class="logout-btn" type="submit">
            Logout
          </button>
        </form>
      </div>
    </div>

    <div class="container">
      ${accountHtml}

      ${
        accounts.length > 0 && pages.length > 0
          ? `
        <section class="publisher-card">
          <div class="publisher-header">
            <h2>Create Post</h2>

            <div id="selected-count">
              0 Pages Selected
            </div>
          </div>

          <form
            id="publish-form"
            method="POST"
            action="/publish"
            enctype="multipart/form-data"
          >
            <div class="field">
              <label for="message">
                Post Text
              </label>

              <textarea
                id="message"
                name="message"
                rows="7"
                placeholder="Write your post..."
              ></textarea>
            </div>

            <div class="field">
              <label for="media">
                Image / Video
              </label>

              <input
                id="media"
                type="file"
                name="media"
                accept="image/*,video/*"
              />

              <div class="hint">
                Leave empty for a text-only post.
              </div>
            </div>

            <button
              class="publish-btn"
              type="submit"
              onclick="return validatePublish()"
            >
              Publish to Selected Pages
            </button>
          </form>

          <div
            id="publish-status"
            class="status-box"
          ></div>
        </section>
        `
          : ""
      }
    </div>

    <script>
      function updateSelectedCount() {
        const checked =
          document.querySelectorAll(
            '.page-checkbox:checked'
          );

        const counter =
          document.getElementById('selected-count');

        if (counter) {
          counter.textContent =
            checked.length +
            ' Page' +
            (checked.length === 1 ? '' : 's') +
            ' Selected';
        }
      }

      function selectAccountPages(
        accountId,
        select
      ) {
        document
          .querySelectorAll(
            '.account-' + accountId
          )
          .forEach(function (checkbox) {
            checkbox.checked = select;
          });

        updateSelectedCount();
      }

      document.addEventListener(
        'change',
        function (event) {
          if (
            event.target &&
            event.target.classList.contains(
              'page-checkbox'
            )
          ) {
            updateSelectedCount();
          }
        }
      );

      function validatePublish() {
        const selected =
          document.querySelectorAll(
            '.page-checkbox:checked'
          );

        if (selected.length === 0) {
          alert(
            'Please select at least one Page.'
          );
          return false;
        }

        const message =
          document
            .getElementById('message')
            .value.trim();

        const media =
          document.getElementById('media')
            .files.length;

        if (!message && !media) {
          alert(
            'Please enter post text or select an image/video.'
          );
          return false;
        }

        return true;
      }

      updateSelectedCount();
    </script>
    `
  );
}

/* =========================================================
   FACEBOOK LOGIN
   ========================================================= */

function startMetaLogin(request, env) {
  let config;

  try {
    config = getMetaConfig(env);
  } catch (error) {
    return page(
      "Meta Configuration Error",
      `
      <div class="error-box">
        <h2>Meta Configuration Error</h2>
        <pre>${escapeHtml(error.message)}</pre>
      </div>
      `
    );
  }

  const requestUrl = new URL(request.url);

  const redirectUri =
    `${requestUrl.origin}/auth/meta/callback`;

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const loginUrl =
    `https://www.facebook.com/${config.graphVersion}/dialog/oauth` +
    `?client_id=${encodeURIComponent(config.appId)}` +
    `&redirect_uri=${encodeURIComponent(
      redirectUri
    )}` +
    `&scope=${encodeURIComponent(scope)}`;

  return Response.redirect(loginUrl, 302);
}

/* =========================================================
   FACEBOOK CALLBACK
   ========================================================= */

async function metaCallback(request, env) {
  const config = getMetaConfig(env);

  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  const errorDescription =
    url.searchParams.get(
      "error_description"
    );

  if (error) {
    return page(
      "Facebook Login Error",
      `
      <div class="error-box">
        <h2>Facebook Login Error</h2>

        <p>${escapeHtml(error)}</p>

        <p>${escapeHtml(
          errorDescription || ""
        )}</p>

        <a class="back-btn" href="/">
          Back to Dashboard
        </a>
      </div>
      `
    );
  }

  if (!code) {
    return page(
      "Facebook Login Error",
      `
      <div class="error-box">
        <h2>No authorization code received.</h2>

        <a class="back-btn" href="/">
          Back to Dashboard
        </a>
      </div>
      `
    );
  }

  const redirectUri =
    `${url.origin}/auth/meta/callback`;

  const tokenUrl =
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token` +
    `?client_id=${encodeURIComponent(
      config.appId
    )}` +
    `&client_secret=${encodeURIComponent(
      config.appSecret
    )}` +
    `&redirect_uri=${encodeURIComponent(
      redirectUri
    )}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenResponse = await fetch(tokenUrl);
  const tokenData =
    await tokenResponse.json();

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    throw new Error(
      `Facebook token exchange failed: ${JSON.stringify(
        tokenData
      )}`
    );
  }

  const userAccessToken =
    tokenData.access_token;

  const userUrl =
    `https://graph.facebook.com/${config.graphVersion}/me` +
    `?fields=id,name` +
    `&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

  const userResponse = await fetch(userUrl);
  const userData =
    await userResponse.json();

  if (
    !userResponse.ok ||
    !userData.id
  ) {
    throw new Error(
      `Could not get Facebook account information: ${JSON.stringify(
        userData
      )}`
    );
  }

  await env.DB.prepare(
    `
    INSERT INTO accounts (
      facebook_user_id,
      account_name,
      access_token
    )
    VALUES (?, ?, ?)
    ON CONFLICT(facebook_user_id)
    DO UPDATE SET
      account_name = excluded.account_name,
      access_token = excluded.access_token
    `
  )
    .bind(
      String(userData.id),
      userData.name ||
        "Facebook Account",
      userAccessToken
    )
    .run();

  const account =
    await env.DB.prepare(
      `
      SELECT id
      FROM accounts
      WHERE facebook_user_id = ?
      `
    )
      .bind(String(userData.id))
      .first();

  if (!account) {
    throw new Error(
      "Facebook account was saved but could not be found."
    );
  }

  await syncAccountPages(
    env,
    Number(account.id),
    userAccessToken,
    config.graphVersion
  );

  return Response.redirect(
    `${url.origin}/`,
    302
  );
}

/* =========================================================
   SYNC PAGES
   ========================================================= */

async function syncPages(request, env) {
  const form =
    await request.formData();

  const accountId = Number(
    form.get("account_id")
  );

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  const account =
    await env.DB.prepare(
      `
      SELECT
        id,
        access_token
      FROM accounts
      WHERE id = ?
      `
    )
      .bind(accountId)
      .first();

  if (!account) {
    throw new Error(
      "Facebook account not found."
    );
  }

  const config =
    getMetaConfig(env);

  await syncAccountPages(
    env,
    account.id,
    account.access_token,
    config.graphVersion
  );

  return Response.redirect(
    "/",
    303
  );
}

async function syncAccountPages(
  env,
  accountId,
  userAccessToken,
  graphVersion
) {
  let nextUrl =
    `https://graph.facebook.com/${graphVersion}/me/accounts` +
    `?fields=id,name,access_token` +
    `&limit=100` +
    `&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

  const foundPageIds = [];

  while (nextUrl) {
    const response =
      await fetch(nextUrl);

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        `Could not load Facebook Pages: ${JSON.stringify(
          data
        )}`
      );
    }

    const pageList =
      data.data || [];

    for (const fbPage of pageList) {
      if (
        !fbPage.id ||
        !fbPage.access_token
      ) {
        continue;
      }

      foundPageIds.push(
        String(fbPage.id)
      );

      await env.DB.prepare(
        `
        INSERT INTO pages (
          facebook_page_id,
          page_name,
          access_token,
          account_id
        )
        VALUES (?, ?, ?, ?)
        ON CONFLICT(facebook_page_id)
        DO UPDATE SET
          page_name = excluded.page_name,
          access_token = excluded.access_token,
          account_id = excluded.account_id
        `
      )
        .bind(
          String(fbPage.id),
          fbPage.name ||
            "Unnamed Page",
          fbPage.access_token,
          Number(accountId)
        )
        .run();
    }

    nextUrl =
      data.paging &&
      data.paging.next
        ? data.paging.next
        : null;
  }

  if (foundPageIds.length > 0) {
    const placeholders =
      foundPageIds
        .map(() => "?")
        .join(",");

    await env.DB.prepare(
      `
      DELETE FROM pages
      WHERE account_id = ?
      AND facebook_page_id NOT IN (${placeholders})
      `
    )
      .bind(
        Number(accountId),
        ...foundPageIds
      )
      .run();
  } else {
    await env.DB.prepare(
      `
      DELETE FROM pages
      WHERE account_id = ?
      `
    )
      .bind(Number(accountId))
      .run();
  }
}

/* =========================================================
   REMOVE ACCOUNT
   ========================================================= */

async function removeAccount(
  request,
  env
) {
  const form =
    await request.formData();

  const accountId = Number(
    form.get("account_id")
  );

  if (!accountId) {
    throw new Error(
      "Invalid account ID."
    );
  }

  await env.DB.prepare(
    `
    DELETE FROM pages
    WHERE account_id = ?
    `
  )
    .bind(accountId)
    .run();

  await env.DB.prepare(
    `
    DELETE FROM accounts
    WHERE id = ?
    `
  )
    .bind(accountId)
    .run();

  return Response.redirect(
    "/",
    303
  );
}

/* =========================================================
   PUBLISH
   ========================================================= */

async function publishPost(
  request,
  env
) {
  const form =
    await request.formData();

  const message = String(
    form.get("message") || ""
  ).trim();

  const selectedPageIds =
    form.getAll("page_ids");

  const media =
    form.get("media");

  if (!selectedPageIds.length) {
    return page(
      "No Pages Selected",
      `
      <div class="error-box">
        <h2>No Pages Selected</h2>

        <p>
          Please select at least one Facebook Page.
        </p>

        <a class="back-btn" href="/">
          Back
        </a>
      </div>
      `
    );
  }

  if (
    !message &&
    (!media || !media.name)
  ) {
    return page(
      "Empty Post",
      `
      <div class="error-box">
        <h2>Empty Post</h2>

        <p>
          Enter text or select an image/video.
        </p>

        <a class="back-btn" href="/">
          Back
        </a>
      </div>
      `
    );
  }

  const numericPageIds =
    selectedPageIds
      .map((id) => Number(id))
      .filter(
        (id) =>
          Number.isInteger(id) &&
          id > 0
      );

  if (!numericPageIds.length) {
    throw new Error(
      "Invalid selected Page IDs."
    );
  }

  const placeholders =
    numericPageIds
      .map(() => "?")
      .join(",");

  const pagesResult =
    await env.DB.prepare(
      `
      SELECT
        id,
        facebook_page_id,
        page_name,
        access_token
      FROM pages
      WHERE id IN (${placeholders})
      ORDER BY page_name COLLATE NOCASE ASC
      `
    )
      .bind(...numericPageIds)
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    throw new Error(
      "Selected Pages were not found in the database."
    );
  }

  const config =
    getMetaConfig(env);

  let mediaBuffer = null;
  let mediaType = null;
  let mediaName = null;

  if (
    media &&
    typeof media === "object" &&
    media.name
  ) {
    mediaName = media.name;

    const contentType =
      media.type || "";

    if (
      contentType.startsWith(
        "image/"
      )
    ) {
      mediaType = "image";
    } else if (
      contentType.startsWith(
        "video/"
      )
    ) {
      mediaType = "video";
    } else {
      const lower =
        mediaName.toLowerCase();

      if (
        lower.endsWith(".jpg") ||
        lower.endsWith(".jpeg") ||
        lower.endsWith(".png") ||
        lower.endsWith(".gif") ||
        lower.endsWith(".webp")
      ) {
        mediaType = "image";
      } else if (
        lower.endsWith(".mp4") ||
        lower.endsWith(".mov") ||
        lower.endsWith(".avi") ||
        lower.endsWith(".mkv") ||
        lower.endsWith(".webm")
      ) {
        mediaType = "video";
      }
    }

    if (!mediaType) {
      throw new Error(
        "Unsupported media type. Please upload an image or video."
      );
    }

    mediaBuffer =
      await media.arrayBuffer();

    if (
      mediaBuffer.byteLength >
      100 * 1024 * 1024
    ) {
      throw new Error(
        "File is too large. Please use a smaller file."
      );
    }
  }

  const results = [];

  for (const fbPage of pages) {
    try {
      let result;

      if (!mediaBuffer) {
        result =
          await publishTextPost(
            fbPage,
            message,
            config.graphVersion
          );
      } else if (
        mediaType === "image"
      ) {
        result =
          await publishImagePost(
            fbPage,
            message,
            mediaBuffer,
            mediaName,
            config.graphVersion
          );
      } else {
        result =
          await publishVideoPost(
            fbPage,
            message,
            mediaBuffer,
            mediaName,
            config.graphVersion
          );
      }

      results.push({
        page: fbPage.page_name,
        pageId:
          fbPage.facebook_page_id,
        success: true,
        postId:
          result?.id || "",
      });
    } catch (error) {
      results.push({
        page: fbPage.page_name,
        pageId:
          fbPage.facebook_page_id,
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }

  const successCount =
    results.filter(
      (r) => r.success
    ).length;

  const failedCount =
    results.length -
    successCount;

  const resultHtml =
    results
      .map(
        (r) => `
        <div class="result-row ${
          r.success
            ? "result-success"
            : "result-failed"
        }">
          <div>
            <strong>
              ${escapeHtml(
                r.page ||
                  "Unnamed Page"
              )}
            </strong>

            <div class="result-page-id">
              ${escapeHtml(
                r.pageId || ""
              )}
            </div>
          </div>

          <div>
            ${
              r.success
                ? `
                  <span class="success-label">
                    ✓ Published
                  </span>
                `
                : `
                  <span class="failed-label">
                    ✕ Failed
                  </span>

                  <div class="result-error">
                    ${escapeHtml(
                      r.error || ""
                    )}
                  </div>
                `
            }
          </div>
        </div>
        `
      )
      .join("");

  return page(
    "Publish Results",
    `
    <div class="result-page">
      <div class="result-card">
        <h1>Publish Results</h1>

        <div class="summary">
          <div>
            <strong>
              ${successCount}
            </strong>
            Published
          </div>

          <div>
            <strong>
              ${failedCount}
            </strong>
            Failed
          </div>

          <div>
            <strong>
              ${results.length}
            </strong>
            Total
          </div>
        </div>

        <div class="results-list">
          ${resultHtml}
        </div>

        <a
          class="back-btn"
          href="/"
        >
          Back to Dashboard
        </a>
      </div>
    </div>
    `
  );
}

/* =========================================================
   FACEBOOK PUBLISH HELPERS
   ========================================================= */

async function publishTextPost(
  fbPage,
  message,
  graphVersion
) {
  const url =
    `https://graph.facebook.com/${graphVersion}/${fbPage.facebook_page_id}/feed`;

  return graphPost(
    url,
    {
      message,
      access_token:
        fbPage.access_token,
    }
  );
}

async function publishImagePost(
  fbPage,
  message,
  mediaBuffer,
  mediaName,
  graphVersion
) {
  const url =
    `https://graph.facebook.com/${graphVersion}/${fbPage.facebook_page_id}/photos`;

  const formData =
    new FormData();

  formData.append(
    "access_token",
    fbPage.access_token
  );

  formData.append(
    "message",
    message
  );

  const file =
    new File(
      [mediaBuffer],
      mediaName,
      {
        type:
          getMimeType(mediaName),
      }
    );

  formData.append(
    "source",
    file
  );

  return graphPostFormData(
    url,
    formData
  );
}

async function publishVideoPost(
  fbPage,
  message,
  mediaBuffer,
  mediaName,
  graphVersion
) {
  const url =
    `https://graph.facebook.com/${graphVersion}/${fbPage.facebook_page_id}/videos`;

  const formData =
    new FormData();

  formData.append(
    "access_token",
    fbPage.access_token
  );

  formData.append(
    "description",
    message
  );

  const file =
    new File(
      [mediaBuffer],
      mediaName,
      {
        type:
          getMimeType(mediaName),
      }
    );

  formData.append(
    "source",
    file
  );

  return graphPostFormData(
    url,
    formData
  );
}

async function graphPost(
  url,
  params
) {
  const body =
    new URLSearchParams();

  for (const [key, value] of Object.entries(
    params
  )) {
    body.append(
      key,
      String(value)
    );
  }

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    });

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      `Facebook API error: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

async function graphPostFormData(
  url,
  formData
) {
  const response =
    await fetch(url, {
      method: "POST",
      body: formData,
    });

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = {
      raw: text,
    };
  }

  if (
    !response.ok ||
    data.error
  ) {
    throw new Error(
      `Facebook API error: ${JSON.stringify(
        data
      )}`
    );
  }

  return data;
}

function getMimeType(
  fileName
) {
  const lower =
    String(fileName || "")
      .toLowerCase();

  if (
    lower.endsWith(".jpg") ||
    lower.endsWith(".jpeg")
  ) {
    return "image/jpeg";
  }

  if (
    lower.endsWith(".png")
  ) {
    return "image/png";
  }

  if (
    lower.endsWith(".gif")
  ) {
    return "image/gif";
  }

  if (
    lower.endsWith(".webp")
  ) {
    return "image/webp";
  }

  if (
    lower.endsWith(".mp4")
  ) {
    return "video/mp4";
  }

  if (
    lower.endsWith(".mov")
  ) {
    return "video/quicktime";
  }

  if (
    lower.endsWith(".avi")
  ) {
    return "video/x-msvideo";
  }

  if (
    lower.endsWith(".mkv")
  ) {
    return "video/x-matroska";
  }

  if (
    lower.endsWith(".webm")
  ) {
    return "video/webm";
  }

  return "application/octet-stream";
}

/* =========================================================
   HTML
   ========================================================= */

function page(
  title,
  content
) {
  return new Response(
    `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">

      <meta
        name="viewport"
        content="width=device-width, initial-scale=1.0"
      >

      <title>
        ${escapeHtml(title)} -
        ${escapeHtml(APP_NAME)}
      </title>

      <style>
        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family:
            Inter,
            system-ui,
            -apple-system,
            BlinkMacSystemFont,
            "Segoe UI",
            sans-serif;
          background: #f4f6f8;
          color: #17202a;
        }

        button,
        input,
        textarea {
          font: inherit;
        }

        .topbar {
          background: #ffffff;
          border-bottom: 1px solid #e5e7eb;
          padding: 18px 28px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 20px;
        }

        .brand {
          font-size: 22px;
          font-weight: 800;
        }

        .subtitle {
          color: #6b7280;
          margin-top: 4px;
          font-size: 14px;
        }

        .topbar-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .connect-btn,
        .logout-btn {
          border: 0;
          text-decoration: none;
          cursor: pointer;
          border-radius: 9px;
          padding: 11px 16px;
          font-weight: 700;
        }

        .connect-btn {
          background: #1877f2;
          color: #ffffff;
        }

        .logout-btn {
          background: #111827;
          color: #ffffff;
        }

        .container {
          width: min(1100px, calc(100% - 30px));
          margin: 28px auto;
        }

        .account-card,
        .publisher-card,
        .result-card,
        .empty-box {
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 14px;
          box-shadow: 0 4px 18px rgba(0,0,0,.04);
        }

        .account-card {
          margin-bottom: 22px;
          overflow: hidden;
        }

        .account-header {
          padding: 20px;
          display: flex;
          justify-content: space-between;
          gap: 20px;
          border-bottom: 1px solid #eef0f2;
        }

        .account-header h2 {
          margin: 0 0 8px;
          font-size: 19px;
        }

        .facebook-id,
        .page-id,
        .result-page-id {
          color: #6b7280;
          font-size: 13px;
        }

        code {
          background: #f1f3f5;
          padding: 2px 6px;
          border-radius: 5px;
          font-size: 12px;
        }

        .page-count {
          margin-top: 7px;
          font-size: 13px;
          font-weight: 700;
          color: #1877f2;
        }

        .account-actions {
          display: flex;
          gap: 8px;
          align-items: flex-start;
        }

        .btn {
          border: 0;
          border-radius: 8px;
          padding: 9px 13px;
          font-weight: 700;
          cursor: pointer;
        }

        .btn-blue {
          background: #e8f1ff;
          color: #1558b0;
        }

        .btn-red {
          background: #feecec;
          color: #b42318;
        }

        .pages-section {
          padding: 18px 20px 22px;
        }

        .list-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 12px;
          gap: 10px;
        }

        .select-actions {
          display: flex;
          gap: 7px;
        }

        .small-btn {
          border: 1px solid #d7dce1;
          background: #ffffff;
          border-radius: 7px;
          padding: 7px 10px;
          cursor: pointer;
          font-size: 12px;
          font-weight: 700;
        }

        .page-list {
          display: flex;
          flex-direction: column;
          gap: 7px;
        }

        .page-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 13px 14px;
          border: 1px solid #e5e7eb;
          border-radius: 9px;
          cursor: pointer;
          transition: .15s ease;
        }

        .page-row:hover {
          border-color: #b8c8dc;
          background: #fafcff;
        }

        .page-row input {
          display: none;
        }

        .page-check {
          width: 20px;
          height: 20px;
          border: 2px solid #c5ccd4;
          border-radius: 5px;
          flex: 0 0 auto;
          position: relative;
        }

        .page-row input:checked + .page-check {
          background: #1877f2;
          border-color: #1877f2;
        }

        .page-row input:checked + .page-check::after {
          content: "";
          position: absolute;
          left: 5px;
          top: 1px;
          width: 5px;
          height: 10px;
          border: solid #ffffff;
          border-width: 0 2px 2px 0;
          transform: rotate(45deg);
        }

        .page-info {
          min-width: 0;
        }

        .page-name {
          font-weight: 700;
          margin-bottom: 3px;
          word-break: break-word;
        }

        .publisher-card {
          padding: 22px;
          margin-top: 28px;
        }

        .publisher-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 15px;
          margin-bottom: 20px;
        }

        .publisher-header h2 {
          margin: 0;
        }

        #selected-count {
          color: #1877f2;
          font-weight: 800;
          font-size: 13px;
        }

        .field {
          margin-bottom: 17px;
        }

        .field label {
          display: block;
          font-weight: 700;
          margin-bottom: 8px;
        }

        textarea,
        .field input[type="password"],
        .field input[type="file"],
        .login-card input {
          width: 100%;
          border: 1px solid #d5dbe1;
          border-radius: 9px;
          padding: 12px;
          background: #ffffff;
        }

        textarea {
          resize: vertical;
        }

        .hint {
          color: #6b7280;
          font-size: 12px;
          margin-top: 6px;
        }

        .publish-btn {
          width: 100%;
          border: 0;
          background: #1877f2;
          color: #ffffff;
          padding: 13px;
          border-radius: 9px;
          cursor: pointer;
          font-weight: 800;
          font-size: 15px;
        }

        .error-box {
          width: min(800px, calc(100% - 30px));
          margin: 50px auto;
          background: #ffffff;
          border: 1px solid #f0c4c4;
          border-radius: 12px;
          padding: 24px;
        }

        .error-box h2 {
          color: #b42318;
          margin-top: 0;
        }

        .error-box pre {
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          background: #f8f9fa;
          padding: 12px;
          border-radius: 8px;
        }

        .back-btn {
          display: inline-block;
          margin-top: 15px;
          text-decoration: none;
          background: #111827;
          color: #ffffff;
          padding: 10px 15px;
          border-radius: 8px;
          font-weight: 700;
        }

        .empty-box {
          padding: 30px;
          text-align: center;
        }

        .no-pages {
          color: #6b7280;
          padding: 14px 0;
        }

        .login-wrapper {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 20px;
        }

        .login-card {
          width: min(420px, 100%);
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 16px;
          padding: 32px;
          box-shadow: 0 10px 40px rgba(0,0,0,.08);
        }

        .login-card h1 {
          margin: 0 0 8px;
          text-align: center;
          font-size: 24px;
        }

        .login-icon {
          text-align: center;
          font-size: 42px;
          margin-bottom: 10px;
        }

        .login-subtitle {
          text-align: center;
          color: #6b7280;
          margin: 0 0 24px;
        }

        .login-error {
          background: #fff0f0;
          border: 1px solid #f3b8b8;
          color: #a61b1b;
          padding: 10px;
          border-radius: 8px;
          margin-bottom: 16px;
          font-size: 14px;
        }

        .login-btn {
          width: 100%;
          border: 0;
          border-radius: 9px;
          padding: 13px;
          background: #1877f2;
          color: #ffffff;
          cursor: pointer;
          font-weight: 800;
          margin-top: 8px;
        }

        .result-page {
          width: min(950px, calc(100% - 30px));
          margin: 35px auto;
        }

        .result-card {
          padding: 25px;
        }

        .result-card h1 {
          margin-top: 0;
        }

        .summary {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin: 18px 0;
        }

        .summary > div {
          background: #f6f8fa;
          border-radius: 9px;
          padding: 12px 16px;
        }

        .summary strong {
          margin-right: 5px;
        }

        .results-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .result-row {
          display: flex;
          justify-content: space-between;
          gap: 20px;
          padding: 14px;
          border-radius: 9px;
          border: 1px solid #e5e7eb;
        }

        .result-success {
          background: #f4fff7;
        }

        .result-failed {
          background: #fff7f7;
        }

        .success-label {
          color: #16803c;
          font-weight: 800;
        }

        .failed-label {
          color: #b42318;
          font-weight: 800;
        }

        .result-error {
          margin-top: 5px;
          font-size: 12px;
          max-width: 500px;
          overflow-wrap: anywhere;
          color: #7f1d1d;
        }

        @media (max-width: 700px) {
          .topbar,
          .account-header,
          .publisher-header,
          .result-row {
            flex-direction: column;
            align-items: stretch;
          }

          .account-actions,
          .topbar-actions {
            flex-wrap: wrap;
          }

          .connect-btn,
          .logout-btn {
            text-align: center;
          }
        }
      </style>
    </head>

    <body>
      ${content}
    </body>
    </html>
    `,
    {
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
        "Cache-Control":
          "no-store",
      },
    }
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
```
