const APP_NAME = "Meta Multi Page Publisher";

export default {
  async fetch(request, env) {
    try {
      await ensureDatabaseSchema(env.DB);

      const url = new URL(request.url);
      const path = url.pathname;

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

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

      return page(
        "Error",
        `
        <div class="error-box">
          <h2>Something went wrong</h2>
          <pre>${escapeHtml(error?.stack || error?.message || String(error))}</pre>
        </div>
        `
      );
    }
  },
};

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
  const graphVersion = String(env.META_GRAPH_VERSION || "").trim();

  const missing = [];

  if (!appId) missing.push("META_APP_ID");
  if (!appSecret) missing.push("META_APP_SECRET");
  if (!graphVersion) missing.push("META_GRAPH_VERSION");

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
      const accountPages = groupedPages[account.id] || [];

      accountHtml += `
        <section class="account-card">

          <div class="account-header">
            <div>
              <h2>${escapeHtml(
                account.account_name || "Facebook Account"
              )}</h2>

              <div class="facebook-id">
                Facebook ID:
                <code>${escapeHtml(account.facebook_user_id)}</code>
              </div>

              <div class="page-count">
                ${accountPages.length} Connected Page${
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
                <button class="btn btn-blue" type="submit">
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
                <button class="btn btn-red" type="submit">
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

      <a class="connect-btn" href="/auth/meta">
        + Connect Facebook Account
      </a>
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

          <div id="publish-status" class="status-box"></div>

        </section>
        `
          : ""
      }

    </div>

    <script>
      function updateSelectedCount() {
        const checked = document.querySelectorAll(
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

      function selectAccountPages(accountId, select) {
        document
          .querySelectorAll('.account-' + accountId)
          .forEach(function (checkbox) {
            checkbox.checked = select;
          });

        updateSelectedCount();
      }

      document.addEventListener('change', function(event) {
        if (
          event.target &&
          event.target.classList.contains('page-checkbox')
        ) {
          updateSelectedCount();
        }
      });

      function validatePublish() {
        const selected =
          document.querySelectorAll(
            '.page-checkbox:checked'
          );

        if (selected.length === 0) {
          alert('Please select at least one Page.');
          return false;
        }

        const message =
          document.getElementById('message').value.trim();

        const media =
          document.getElementById('media').files.length;

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
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
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
    url.searchParams.get("error_description");

  if (error) {
    return page(
      "Facebook Login Error",
      `
      <div class="error-box">
        <h2>Facebook Login Error</h2>
        <p>${escapeHtml(error)}</p>
        <p>${escapeHtml(errorDescription || "")}</p>
        <a class="back-btn" href="/">Back to Dashboard</a>
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
        <a class="back-btn" href="/">Back to Dashboard</a>
      </div>
      `
    );
  }

  const redirectUri =
    `${url.origin}/auth/meta/callback`;

  const tokenUrl =
    `https://graph.facebook.com/${config.graphVersion}/oauth/access_token` +
    `?client_id=${encodeURIComponent(config.appId)}` +
    `&client_secret=${encodeURIComponent(config.appSecret)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenResponse = await fetch(tokenUrl);
  const tokenData = await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      `Facebook token exchange failed: ${JSON.stringify(
        tokenData
      )}`
    );
  }

  const userAccessToken = tokenData.access_token;

  const userUrl =
    `https://graph.facebook.com/${config.graphVersion}/me` +
    `?fields=id,name` +
    `&access_token=${encodeURIComponent(
      userAccessToken
    )}`;

  const userResponse = await fetch(userUrl);
  const userData = await userResponse.json();

  if (!userResponse.ok || !userData.id) {
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
      userData.name || "Facebook Account",
      userAccessToken
    )
    .run();

  const account = await env.DB.prepare(
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
  const form = await request.formData();

  const accountId = Number(
    form.get("account_id")
  );

  if (!accountId) {
    throw new Error("Invalid account ID.");
  }

  const account = await env.DB.prepare(
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
    throw new Error("Facebook account not found.");
  }

  const config = getMetaConfig(env);

  await syncAccountPages(
    env,
    account.id,
    account.access_token,
    config.graphVersion
  );

  return Response.redirect("/", 303);
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
    const response = await fetch(nextUrl);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        `Could not load Facebook Pages: ${JSON.stringify(
          data
        )}`
      );
    }

    const pageList = data.data || [];

    for (const fbPage of pageList) {
      if (!fbPage.id || !fbPage.access_token) {
        continue;
      }

      foundPageIds.push(String(fbPage.id));

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
          fbPage.name || "Unnamed Page",
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
    const placeholders = foundPageIds
      .map(() => "?")
      .join(",");

    await env.DB.prepare(
      `
      DELETE FROM pages
      WHERE account_id = ?
      AND facebook_page_id NOT IN (${placeholders})
      `
    )
      .bind(Number(accountId), ...foundPageIds)
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

async function removeAccount(request, env) {
  const form = await request.formData();

  const accountId = Number(
    form.get("account_id")
  );

  if (!accountId) {
    throw new Error("Invalid account ID.");
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

  return Response.redirect("/", 303);
}

/* =========================================================
   PUBLISH
========================================================= */

async function publishPost(request, env) {
  const form = await request.formData();

  const message = String(
    form.get("message") || ""
  ).trim();

  const selectedPageIds =
    form.getAll("page_ids");

  const media = form.get("media");

  if (!selectedPageIds.length) {
    return page(
      "No Pages Selected",
      `
      <div class="error-box">
        <h2>No Pages Selected</h2>
        <p>Please select at least one Facebook Page.</p>
        <a class="back-btn" href="/">Back</a>
      </div>
      `
    );
  }

  if (!message && (!media || !media.name)) {
    return page(
      "Empty Post",
      `
      <div class="error-box">
        <h2>Empty Post</h2>
        <p>Enter text or select an image/video.</p>
        <a class="back-btn" href="/">Back</a>
      </div>
      `
    );
  }

  const numericPageIds = selectedPageIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (!numericPageIds.length) {
    throw new Error("Invalid selected Page IDs.");
  }

  const placeholders = numericPageIds
    .map(() => "?")
    .join(",");

  const pagesResult = await env.DB.prepare(
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

  const pages = pagesResult.results || [];

  if (!pages.length) {
    throw new Error(
      "Selected Pages were not found in the database."
    );
  }

  const config = getMetaConfig(env);

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
      contentType.startsWith("image/")
    ) {
      mediaType = "image";
    } else if (
      contentType.startsWith("video/")
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

    mediaBuffer = await media.arrayBuffer();

    if (mediaBuffer.byteLength > 100 * 1024 * 1024) {
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
        result = await publishTextPost(
          fbPage,
          message,
          config.graphVersion
        );
      } else if (mediaType === "image") {
        result = await publishImagePost(
          fbPage,
          message,
          mediaBuffer,
          mediaName,
          config.graphVersion
        );
      } else {
        result = await publishVideoPost(
          fbPage,
          message,
          mediaBuffer,
          mediaName,
          config.graphVersion
        );
      }

      results.push({
        page: fbPage.page_name,
        pageId: fbPage.facebook_page_id,
        success: true,
        postId: result?.id || "",
      });
    } catch (error) {
      results.push({
        page: fbPage.page_name,
        pageId: fbPage.facebook_page_id,
        success: false,
        error:
          error?.message ||
          String(error),
      });
    }
  }

  return page(
    "Publish Results",
    `
    <div class="results-card">

      <h2>Publish Results</h2>

      <div class="result-summary">
        ${results.filter((r) => r.success).length}
        successful /
        ${results.length}
        total
      </div>

      <div class="results-list">

        ${results
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
                    r.page || "Unnamed Page"
                  )}
                </strong>

                <div class="result-page-id">
                  Page ID:
                  ${escapeHtml(
                    r.pageId
                  )}
                </div>
              </div>

              <div class="result-status">
                ${
                  r.success
                    ? "✓ Published"
                    : "✕ Failed"
                }
              </div>

              ${
                r.success
                  ? r.postId
                    ? `
                    <div class="result-error">
                      Post ID:
                      ${escapeHtml(
                        r.postId
                      )}
                    </div>
                    `
                    : ""
                  : `
                    <div class="result-error">
                      ${escapeHtml(
                        r.error || ""
                      )}
                    </div>
                  `
              }

            </div>
          `
          )
          .join("")}

      </div>

      <a class="back-btn" href="/">
        Back to Dashboard
      </a>

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

  const body = new URLSearchParams();

  body.set(
    "message",
    message
  );

  body.set(
    "access_token",
    fbPage.access_token
  );

  return graphPost(url, body);
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

  const form = new FormData();

  form.append(
    "access_token",
    fbPage.access_token
  );

  if (message) {
    form.append(
      "caption",
      message
    );
  }

  form.append(
    "source",
    new File(
      [mediaBuffer],
      mediaName || "image.jpg"
    )
  );

  return graphPostFormData(
    url,
    form
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

  const form = new FormData();

  form.append(
    "access_token",
    fbPage.access_token
  );

  if (message) {
    form.append(
      "description",
      message
    );
  }

  form.append(
    "source",
    new File(
      [mediaBuffer],
      mediaName || "video.mp4"
    )
  );

  return graphPostFormData(
    url,
    form
  );
}

async function graphPost(
  url,
  body
) {
  const response = await fetch(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type":
          "application/x-www-form-urlencoded",
      },
      body,
    }
  );

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      formatGraphError(data)
    );
  }

  return data;
}

async function graphPostFormData(
  url,
  form
) {
  const response = await fetch(
    url,
    {
      method: "POST",
      body: form,
    }
  );

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      formatGraphError(data)
    );
  }

  return data;
}

function formatGraphError(data) {
  if (
    data &&
    data.error
  ) {
    const e = data.error;

    return [
      e.message,
      e.type
        ? `Type: ${e.type}`
        : "",
      e.code !== undefined
        ? `Code: ${e.code}`
        : "",
      e.error_subcode !== undefined
        ? `Subcode: ${e.error_subcode}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
  }

  return JSON.stringify(data);
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
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <title>
    ${escapeHtml(title)} - ${APP_NAME}
  </title>

  <style>

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f4f7fb;
      color: #172033;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
    }

    .topbar {
      background: #ffffff;
      border-bottom: 1px solid #e2e7ef;
      padding: 20px 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      position: sticky;
      top: 0;
      z-index: 20;
    }

    .brand {
      font-size: 23px;
      font-weight: 800;
    }

    .subtitle {
      margin-top: 4px;
      color: #687386;
      font-size: 13px;
    }

    .connect-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #1877f2;
      color: white;
      text-decoration: none;
      padding: 12px 18px;
      border-radius: 8px;
      font-weight: 700;
      white-space: nowrap;
    }

    .connect-btn:hover {
      opacity: .92;
    }

    .container {
      max-width: 1100px;
      margin: 30px auto;
      padding: 0 18px 60px;
    }

    .account-card,
    .publisher-card,
    .results-card,
    .empty-box,
    .error-box {
      background: white;
      border: 1px solid #e1e6ee;
      border-radius: 14px;
      box-shadow:
        0 5px 20px rgba(20, 30, 50, .05);
      margin-bottom: 24px;
    }

    .account-card {
      overflow: hidden;
    }

    .account-header {
      padding: 22px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: center;
      border-bottom: 1px solid #edf0f5;
    }

    .account-header h2 {
      margin: 0 0 8px;
      font-size: 20px;
    }

    .facebook-id {
      color: #697589;
      font-size: 13px;
      margin-bottom: 8px;
    }

    code {
      background: #f0f3f7;
      padding: 3px 6px;
      border-radius: 5px;
      font-size: 12px;
      color: #27344a;
      word-break: break-all;
    }

    .page-count {
      display: inline-block;
      background: #eef5ff;
      color: #1769d2;
      font-weight: 700;
      font-size: 13px;
      padding: 6px 10px;
      border-radius: 20px;
    }

    .account-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .account-actions form {
      margin: 0;
    }

    .btn {
      border: 0;
      border-radius: 7px;
      padding: 10px 14px;
      cursor: pointer;
      font-weight: 700;
    }

    .btn-blue {
      background: #1877f2;
      color: white;
    }

    .btn-red {
      background: #fff0f0;
      color: #d32f2f;
      border: 1px solid #ffd1d1;
    }

    .pages-section {
      padding: 20px 22px 24px;
    }

    .list-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 15px;
    }

    .select-actions {
      display: flex;
      gap: 7px;
    }

    .small-btn {
      background: #f4f6f9;
      color: #27344a;
      border: 1px solid #dfe4eb;
      border-radius: 6px;
      padding: 7px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 700;
    }

    .page-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .page-row {
      display: flex;
      align-items: center;
      gap: 14px;
      min-height: 68px;
      padding: 13px 15px;
      background: #fafbfd;
      border: 1px solid #e5e9f0;
      border-radius: 9px;
      cursor: pointer;
      transition:
        border-color .15s,
        background .15s,
        transform .15s;
    }

    .page-row:hover {
      background: #f5f9ff;
      border-color: #b8d3f7;
    }

    .page-row:has(
      .page-checkbox:checked
    ) {
      background: #f0f7ff;
      border-color: #76aef1;
    }

    .page-checkbox {
      width: 19px;
      height: 19px;
      flex: 0 0 auto;
      cursor: pointer;
    }

    .page-info {
      min-width: 0;
      flex: 1;
    }

    .page-name {
      font-size: 15px;
      font-weight: 750;
      margin-bottom: 6px;
      color: #1c2738;
    }

    .page-id {
      font-size: 12px;
      color: #758095;
    }

    .page-id code {
      background: transparent;
      padding: 0;
      color: #687386;
    }

    .no-pages {
      padding: 20px;
      background: #f8fafc;
      border-radius: 8px;
      color: #697589;
      text-align: center;
    }

    .publisher-card {
      padding: 24px;
    }

    .publisher-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
      margin-bottom: 22px;
    }

    .publisher-header h2 {
      margin: 0;
    }

    #selected-count {
      background: #eef5ff;
      color: #1769d2;
      border-radius: 20px;
      padding: 7px 11px;
      font-size: 13px;
      font-weight: 700;
    }

    .field {
      margin-bottom: 20px;
    }

    .field label {
      display: block;
      font-weight: 700;
      margin-bottom: 8px;
    }

    textarea {
      width: 100%;
      resize: vertical;
      border: 1px solid #dce2eb;
      border-radius: 8px;
      padding: 13px;
      font: inherit;
      outline: none;
    }

    textarea:focus {
      border-color: #1877f2;
      box-shadow:
        0 0 0 3px rgba(24,119,242,.10);
    }

    input[type="file"] {
      width: 100%;
      border: 1px solid #dce2eb;
      border-radius: 8px;
      padding: 11px;
      background: white;
    }

    .hint {
      color: #7a8495;
      font-size: 12px;
      margin-top: 7px;
    }

    .publish-btn {
      width: 100%;
      border: 0;
      background: #1877f2;
      color: white;
      padding: 14px;
      border-radius: 9px;
      font-size: 15px;
      font-weight: 800;
      cursor: pointer;
    }

    .publish-btn:hover {
      opacity: .93;
    }

    .empty-box,
    .error-box,
    .results-card {
      padding: 28px;
    }

    .error-box {
      max-width: 900px;
      margin: 50px auto;
    }

    .error-box h2 {
      margin-top: 0;
    }

    pre {
      background: #f5f6f8;
      padding: 15px;
      border-radius: 8px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .back-btn {
      display: inline-block;
      margin-top: 20px;
      padding: 11px 16px;
      background: #1877f2;
      color: white;
      text-decoration: none;
      border-radius: 7px;
      font-weight: 700;
    }

    .result-summary {
      margin: 12px 0 20px;
      font-weight: 700;
      color: #536075;
    }

    .results-list {
      display: flex;
      flex-direction: column;
      gap: 9px;
    }

    .result-row {
      border: 1px solid #e1e6ee;
      border-radius: 9px;
      padding: 14px;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px 15px;
    }

    .result-success {
      background: #f6fff8;
      border-color: #cdebd5;
    }

    .result-failed {
      background: #fff8f8;
      border-color: #f1d0d0;
    }

    .result-page-id {
      margin-top: 5px;
      color: #7b8596;
      font-size: 12px;
    }

    .result-status {
      font-weight: 800;
    }

    .result-success .result-status {
      color: #218838;
    }

    .result-failed .result-status {
      color: #d32f2f;
    }

    .result-error {
      grid-column: 1 / -1;
      color: #697589;
      font-size: 12px;
      word-break: break-word;
    }

    @media (max-width: 700px) {

      .topbar {
        flex-direction: column;
        align-items: stretch;
      }

      .connect-btn {
        width: 100%;
      }

      .account-header {
        flex-direction: column;
        align-items: stretch;
      }

      .account-actions {
        width: 100%;
      }

      .account-actions form {
        flex: 1;
      }

      .account-actions button {
        width: 100%;
      }

      .list-toolbar {
        flex-direction: column;
        align-items: stretch;
      }

      .select-actions {
        width: 100%;
      }

      .small-btn {
        flex: 1;
      }

      .publisher-header {
        flex-direction: column;
        align-items: stretch;
      }

      .result-row {
        grid-template-columns: 1fr;
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

/* =========================================================
   ESCAPE HTML
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
