```javascript
export default {
  async fetch(request, env) {
    try {
      if (!env.META_APP_ID) {
        return htmlResult("Configuration Error", "META_APP_ID is missing.");
      }

      if (!env.META_APP_SECRET) {
        return htmlResult("Configuration Error", "META_APP_SECRET is missing.");
      }

      if (!env.META_GRAPH_VERSION) {
        return htmlResult("Configuration Error", "META_GRAPH_VERSION is missing.");
      }

      if (!env.DB) {
        return htmlResult("Configuration Error", "D1 database binding DB is missing.");
      }

      await ensureAccountNameColumn(env.DB);

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return await dashboard(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/meta") {
        return metaLogin(request, env);
      }

      if (request.method === "GET" && url.pathname === "/auth/meta/callback") {
        return await metaCallback(request, env);
      }

      if (request.method === "POST" && url.pathname === "/sync-pages") {
        return await syncPages(request, env);
      }

      if (request.method === "POST" && url.pathname === "/remove-account") {
        return await removeAccount(request, env);
      }

      if (request.method === "POST" && url.pathname === "/publish") {
        return await publish(request, env);
      }

      return new Response("Not Found", { status: 404 });

    } catch (error) {
      console.error("Worker Error:", error);

      return htmlResult(
        "Server Error",
        error && error.stack
          ? error.stack
          : String(error)
      );
    }
  }
};


/* =========================================================
   DASHBOARD
========================================================= */

async function dashboard(env) {
  const accountsResult = await env.DB.prepare(`
    SELECT
      id,
      facebook_user_id,
      account_name,
      access_token,
      created_at
    FROM accounts
    ORDER BY id ASC
  `).all();

  const accounts = accountsResult.results || [];

  for (const account of accounts) {
    try {
      const freshName = await getFacebookAccountName(
        account.access_token,
        env
      );

      if (
        freshName &&
        freshName !== account.account_name &&
        !isPlaceholderAccountName(account.account_name)
      ) {
        await env.DB.prepare(`
          UPDATE accounts
          SET account_name = ?
          WHERE id = ?
        `)
          .bind(freshName, account.id)
          .run();

        account.account_name = freshName;
      } else if (
        freshName &&
        isPlaceholderAccountName(account.account_name)
      ) {
        await env.DB.prepare(`
          UPDATE accounts
          SET account_name = ?
          WHERE id = ?
        `)
          .bind(freshName, account.id)
          .run();

        account.account_name = freshName;
      }
    } catch (e) {
      console.error(
        "Account name refresh failed:",
        account.facebook_user_id,
        e
      );
    }
  }

  const pagesResult = await env.DB.prepare(`
    SELECT
      id,
      facebook_page_id,
      page_name,
      access_token,
      account_id
    FROM pages
    ORDER BY account_id ASC, page_name ASC
  `).all();

  const pages = pagesResult.results || [];

  const accountCards = accounts.map((account, index) => {
    const accountPages = pages.filter(
      page => Number(page.account_id) === Number(account.id)
    );

    const displayName =
      getSafeAccountDisplayName(account, index);

    return `
      <div class="account-card">

        <div class="account-header">
          <div>
            <div class="account-title">
              ${escapeHtml(displayName)}
            </div>

            <div class="account-id">
              Facebook ID:
              ${escapeHtml(account.facebook_user_id || "")}
            </div>

            <div class="page-count">
              ${accountPages.length} Connected Pages
            </div>
          </div>

          <div class="account-actions">
            <button
              type="button"
              class="btn btn-sync"
              onclick="syncAccount(${Number(account.id)})"
            >
              Sync Pages
            </button>

            <button
              type="button"
              class="btn btn-remove"
              onclick="removeAccount(${Number(account.id)})"
            >
              Remove
            </button>
          </div>
        </div>

        <div class="pages-grid">
          ${
            accountPages.length
              ? accountPages.map(page => `
                  <label class="page-item">
                    <input
                      type="checkbox"
                      class="page-checkbox"
                      name="page_ids"
                      value="${escapeHtmlAttr(page.facebook_page_id)}"
                      data-account-id="${Number(account.id)}"
                    >

                    <span class="page-name">
                      ${escapeHtml(page.page_name || "Unnamed Page")}
                    </span>

                    <span class="page-id">
                      ${escapeHtml(page.facebook_page_id || "")}
                    </span>
                  </label>
                `).join("")
              : `
                <div class="empty-pages">
                  No pages connected to this account.
                </div>
              `
          }
        </div>

      </div>
    `;
  }).join("");

  return new Response(
    dashboardHtml({
      accounts,
      pages,
      accountCards
    }),
    {
      headers: {
        "content-type": "text/html; charset=UTF-8"
      }
    }
  );
}


/* =========================================================
   META LOGIN
========================================================= */

function metaLogin(request, env) {
  const url = new URL(request.url);

  const redirectUri =
    `${url.origin}/auth/meta/callback`;

  const scope =
    "pages_show_list,pages_read_engagement,pages_manage_posts";

  const loginUrl =
    `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth` +
    `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=${encodeURIComponent(scope)}`;

  return Response.redirect(loginUrl, 302);
}


/* =========================================================
   META CALLBACK
========================================================= */

async function metaCallback(request, env) {
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const errorDescription =
    url.searchParams.get("error_description");

  if (error) {
    return htmlResult(
      "Facebook Login Error",
      `${escapeHtml(error)}<br><br>${escapeHtml(
        errorDescription || ""
      )}`
    );
  }

  if (!code) {
    return htmlResult(
      "Facebook Login Error",
      "No authorization code was returned by Facebook."
    );
  }

  const redirectUri =
    `${url.origin}/auth/meta/callback`;

  const tokenUrl =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` +
    `?client_id=${encodeURIComponent(env.META_APP_ID)}` +
    `&client_secret=${encodeURIComponent(env.META_APP_SECRET)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code=${encodeURIComponent(code)}`;

  const tokenResponse =
    await fetch(tokenUrl);

  const tokenData =
    await tokenResponse.json();

  if (!tokenResponse.ok || !tokenData.access_token) {
    return htmlResult(
      "Facebook Token Error",
      `<pre>${escapeHtml(
        JSON.stringify(tokenData, null, 2)
      )}</pre>`
    );
  }

  const userToken =
    tokenData.access_token;

  const me =
    await getFacebookMe(userToken, env);

  if (!me || !me.id) {
    return htmlResult(
      "Facebook Account Error",
      "Could not retrieve Facebook account information."
    );
  }

  const accountName =
    me.name || `Facebook Account ${me.id}`;

  const existing =
    await env.DB.prepare(`
      SELECT id
      FROM accounts
      WHERE facebook_user_id = ?
      LIMIT 1
    `)
      .bind(String(me.id))
      .first();

  let accountId;

  if (existing) {
    accountId = existing.id;

    await env.DB.prepare(`
      UPDATE accounts
      SET
        account_name = ?,
        access_token = ?
      WHERE id = ?
    `)
      .bind(
        accountName,
        userToken,
        accountId
      )
      .run();

  } else {
    const inserted =
      await env.DB.prepare(`
        INSERT INTO accounts
          (facebook_user_id, account_name, access_token, created_at)
        VALUES
          (?, ?, ?, datetime('now'))
      `)
        .bind(
          String(me.id),
          accountName,
          userToken
        )
        .run();

    accountId =
      inserted.meta.last_row_id;
  }

  try {
    const facebookPages =
      await fetchAllFacebookPages(
        userToken,
        env
      );

    for (const page of facebookPages) {
      await upsertPage(
        env.DB,
        accountId,
        page
      );
    }
  } catch (pageError) {
    console.error(
      "Initial page sync failed:",
      pageError
    );
  }

  return Response.redirect(
    `${url.origin}/`,
    302
  );
}


/* =========================================================
   SYNC PAGES
========================================================= */

async function syncPages(request, env) {
  const formData =
    await request.formData();

  const accountId =
    formData.get("account_id");

  if (!accountId) {
    return htmlResult(
      "Sync Error",
      "Missing account ID."
    );
  }

  const account =
    await env.DB.prepare(`
      SELECT
        id,
        facebook_user_id,
        account_name,
        access_token
      FROM accounts
      WHERE id = ?
      LIMIT 1
    `)
      .bind(Number(accountId))
      .first();

  if (!account) {
    return htmlResult(
      "Sync Error",
      "Facebook account not found."
    );
  }

  try {
    const freshMe =
      await getFacebookMe(
        account.access_token,
        env
      );

    if (freshMe && freshMe.name) {
      await env.DB.prepare(`
        UPDATE accounts
        SET account_name = ?
        WHERE id = ?
      `)
        .bind(
          freshMe.name,
          account.id
        )
        .run();
    }

    const facebookPages =
      await fetchAllFacebookPages(
        account.access_token,
        env
      );

    for (const page of facebookPages) {
      await upsertPage(
        env.DB,
        account.id,
        page
      );
    }

    return Response.redirect(
      new URL("/", request.url).toString(),
      303
    );

  } catch (error) {
    return htmlResult(
      "Sync Error",
      `<pre>${escapeHtml(
        error && error.stack
          ? error.stack
          : String(error)
      )}</pre>`
    );
  }
}


/* =========================================================
   REMOVE ACCOUNT
========================================================= */

async function removeAccount(request, env) {
  const formData =
    await request.formData();

  const accountId =
    formData.get("account_id");

  if (!accountId) {
    return htmlResult(
      "Remove Error",
      "Missing account ID."
    );
  }

  await env.DB.prepare(`
    DELETE FROM pages
    WHERE account_id = ?
  `)
    .bind(Number(accountId))
    .run();

  await env.DB.prepare(`
    DELETE FROM accounts
    WHERE id = ?
  `)
    .bind(Number(accountId))
    .run();

  return Response.redirect(
    new URL("/", request.url).toString(),
    303
  );
}


/* =========================================================
   PUBLISH
========================================================= */

async function publish(request, env) {
  const formData =
    await request.formData();

  const message =
    String(formData.get("message") || "").trim();

  const selectedPageIds =
    formData
      .getAll("page_ids")
      .map(value => String(value).trim())
      .filter(Boolean);

  const image =
    formData.get("image");

  const video =
    formData.get("video");

  if (!selectedPageIds.length) {
    return publishResultsPage({
      success: false,
      title: "No Pages Selected",
      message:
        "Please select at least one Facebook Page.",
      results: []
    });
  }

  if (!message && !(image instanceof File && image.size > 0) && !(video instanceof File && video.size > 0)) {
    return publishResultsPage({
      success: false,
      title: "Empty Post",
      message:
        "Please enter a message or select an image/video.",
      results: []
    });
  }

  if (
    image instanceof File &&
    image.size > 0 &&
    video instanceof File &&
    video.size > 0
  ) {
    return publishResultsPage({
      success: false,
      title: "Invalid Post",
      message:
        "Please select either an image or a video, not both.",
      results: []
    });
  }

  const placeholders =
    selectedPageIds
      .map(() => "?")
      .join(",");

  const pagesResult =
    await env.DB.prepare(`
      SELECT
        id,
        facebook_page_id,
        page_name,
        access_token,
        account_id
      FROM pages
      WHERE facebook_page_id IN (${placeholders})
    `)
      .bind(...selectedPageIds)
      .all();

  const pages =
    pagesResult.results || [];

  if (!pages.length) {
    return publishResultsPage({
      success: false,
      title: "Pages Not Found",
      message:
        "The selected Page IDs were submitted, but no matching Pages were found in the database.",
      results: []
    });
  }

  const results = [];

  for (const page of pages) {
    try {
      let result;

      if (
        video instanceof File &&
        video.size > 0
      ) {
        result =
          await publishVideo(
            page,
            message,
            video,
            env
          );

      } else if (
        image instanceof File &&
        image.size > 0
      ) {
        result =
          await publishImage(
            page,
            message,
            image,
            env
          );

      } else {
        result =
          await publishText(
            page,
            message,
            env
          );
      }

      results.push({
        page_name:
          page.page_name || "Unnamed Page",
        page_id:
          page.facebook_page_id,
        success: true,
        response: result
      });

    } catch (error) {
      results.push({
        page_name:
          page.page_name || "Unnamed Page",
        page_id:
          page.facebook_page_id,
        success: false,
        error:
          error && error.message
            ? error.message
            : String(error)
      });
    }
  }

  const successful =
    results.filter(
      item => item.success
    ).length;

  return publishResultsPage({
    success: successful > 0,
    title:
      successful === results.length
        ? "Published Successfully"
        : successful > 0
          ? "Partially Published"
          : "Publish Failed",
    message:
      `${successful} of ${results.length} selected Pages published successfully.`,
    results
  });
}


/* =========================================================
   TEXT POST
========================================================= */

async function publishText(page, message, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.facebook_page_id)}/feed`;

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "content-type":
          "application/x-www-form-urlencoded"
      },
      body:
        new URLSearchParams({
          message,
          access_token:
            page.access_token
        })
    });

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      JSON.stringify(data)
    );
  }

  return data;
}


/* =========================================================
   IMAGE POST
========================================================= */

async function publishImage(page, message, image, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.facebook_page_id)}/photos`;

  const body =
    new FormData();

  body.append(
    "access_token",
    page.access_token
  );

  if (message) {
    body.append(
      "message",
      message
    );
  }

  body.append(
    "source",
    image,
    image.name || "image"
  );

  const response =
    await fetch(url, {
      method: "POST",
      body
    });

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      JSON.stringify(data)
    );
  }

  return data;
}


/* =========================================================
   VIDEO POST
========================================================= */

async function publishVideo(page, message, video, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(page.facebook_page_id)}/videos`;

  const body =
    new FormData();

  body.append(
    "access_token",
    page.access_token
  );

  if (message) {
    body.append(
      "description",
      message
    );
  }

  body.append(
    "source",
    video,
    video.name || "video"
  );

  const response =
    await fetch(url, {
      method: "POST",
      body
    });

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      JSON.stringify(data)
    );
  }

  return data;
}


/* =========================================================
   FACEBOOK API HELPERS
========================================================= */

async function getFacebookMe(accessToken, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me` +
    `?fields=id,name` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (!response.ok || data.error) {
    throw new Error(
      data.error?.message ||
      JSON.stringify(data)
    );
  }

  return data;
}


async function getFacebookAccountName(accessToken, env) {
  try {
    const me =
      await getFacebookMe(
        accessToken,
        env
      );

    return me?.name || null;
  } catch (error) {
    console.error(
      "getFacebookAccountName:",
      error
    );

    return null;
  }
}


async function fetchAllFacebookPages(accessToken, env) {
  const allPages = [];

  let nextUrl =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
    `?fields=id,name,access_token` +
    `&limit=100` +
    `&access_token=${encodeURIComponent(accessToken)}`;

  while (nextUrl) {
    const response =
      await fetch(nextUrl);

    const data =
      await response.json();

    if (!response.ok || data.error) {
      throw new Error(
        data.error?.message ||
        JSON.stringify(data)
      );
    }

    if (Array.isArray(data.data)) {
      allPages.push(
        ...data.data
      );
    }

    nextUrl =
      data.paging?.next || null;
  }

  return allPages;
}


/* =========================================================
   DATABASE HELPERS
========================================================= */

async function ensureAccountNameColumn(db) {
  try {
    await db.prepare(`
      ALTER TABLE accounts
      ADD COLUMN account_name TEXT
    `).run();
  } catch (error) {
    const message =
      String(error?.message || error);

    if (
      !message.toLowerCase().includes(
        "duplicate"
      ) &&
      !message.toLowerCase().includes(
        "already exists"
      )
    ) {
      console.error(
        "ensureAccountNameColumn:",
        error
      );
    }
  }
}


async function upsertPage(db, accountId, page) {
  const existing =
    await db.prepare(`
      SELECT id
      FROM pages
      WHERE facebook_page_id = ?
      LIMIT 1
    `)
      .bind(String(page.id))
      .first();

  if (existing) {
    await db.prepare(`
      UPDATE pages
      SET
        page_name = ?,
        access_token = ?,
        account_id = ?
      WHERE facebook_page_id = ?
    `)
      .bind(
        page.name || "Unnamed Page",
        page.access_token,
        Number(accountId),
        String(page.id)
      )
      .run();

  } else {
    await db.prepare(`
      INSERT INTO pages
        (
          facebook_page_id,
          page_name,
          access_token,
          account_id
        )
      VALUES
        (?, ?, ?, ?)
    `)
      .bind(
        String(page.id),
        page.name || "Unnamed Page",
        page.access_token,
        Number(accountId)
      )
      .run();
  }
}


/* =========================================================
   ACCOUNT NAME HELPERS
========================================================= */

function isPlaceholderAccountName(name) {
  if (!name) {
    return true;
  }

  return /^Facebook Account \d+$/.test(
    String(name).trim()
  );
}


function getSafeAccountDisplayName(account, index) {
  if (
    account.account_name &&
    !isPlaceholderAccountName(account.account_name)
  ) {
    return account.account_name;
  }

  return `Facebook Account ${index + 1}`;
}


/* =========================================================
   DASHBOARD HTML
========================================================= */

function dashboardHtml({
  accounts,
  pages,
  accountCards
}) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <title>Meta Multi Page Publisher</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      padding: 0;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
      background: #f4f6f8;
      color: #111827;
    }

    .container {
      width: min(1400px, 94%);
      margin: 30px auto 60px;
    }

    h1 {
      margin: 0 0 8px;
      font-size: 30px;
    }

    .subtitle {
      color: #6b7280;
      margin-bottom: 24px;
    }

    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 15px;
      margin-bottom: 25px;
      flex-wrap: wrap;
    }

    .connect-btn {
      display: inline-block;
      text-decoration: none;
      background: #1877f2;
      color: white;
      padding: 12px 18px;
      border-radius: 8px;
      font-weight: 700;
    }

    .stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 25px;
    }

    .stat {
      background: white;
      border-radius: 12px;
      padding: 16px 20px;
      box-shadow:
        0 2px 10px rgba(0,0,0,.06);
    }

    .stat-number {
      font-size: 25px;
      font-weight: 800;
    }

    .stat-label {
      color: #6b7280;
      margin-top: 4px;
    }

    .account-card {
      background: white;
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 20px;
      box-shadow:
        0 2px 12px rgba(0,0,0,.06);
    }

    .account-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 15px;
      margin-bottom: 18px;
      flex-wrap: wrap;
    }

    .account-title {
      font-size: 20px;
      font-weight: 800;
    }

    .account-id {
      color: #6b7280;
      font-size: 13px;
      margin-top: 5px;
    }

    .page-count {
      margin-top: 7px;
      font-size: 13px;
      font-weight: 700;
    }

    .account-actions {
      display: flex;
      gap: 8px;
    }

    .btn {
      border: 0;
      border-radius: 7px;
      padding: 9px 13px;
      cursor: pointer;
      font-weight: 700;
    }

    .btn-sync {
      background: #e8f1ff;
      color: #155eef;
    }

    .btn-remove {
      background: #fee2e2;
      color: #b91c1c;
    }

    .pages-grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fill, minmax(250px, 1fr));
      gap: 10px;
    }

    .page-item {
      border: 1px solid #e5e7eb;
      border-radius: 9px;
      padding: 12px;
      cursor: pointer;
      display: block;
      transition: .15s;
    }

    .page-item:hover {
      border-color: #1877f2;
      background: #f8fbff;
    }

    .page-item input {
      margin-right: 8px;
      transform: scale(1.15);
    }

    .page-name {
      font-weight: 700;
    }

    .page-id {
      display: block;
      color: #9ca3af;
      font-size: 11px;
      margin-top: 5px;
      margin-left: 24px;
      word-break: break-all;
    }

    .empty-pages {
      color: #6b7280;
      padding: 10px 0;
    }

    .publisher {
      background: white;
      border-radius: 14px;
      padding: 22px;
      margin-top: 25px;
      box-shadow:
        0 2px 12px rgba(0,0,0,.06);
    }

    .publisher h2 {
      margin-top: 0;
    }

    .search-box {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      font-size: 15px;
    }

    .select-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 15px;
    }

    .small-btn {
      border: 0;
      border-radius: 7px;
      padding: 9px 13px;
      cursor: pointer;
      background: #eef2f7;
      font-weight: 700;
    }

    textarea {
      width: 100%;
      min-height: 150px;
      resize: vertical;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 13px;
      font-family: inherit;
      font-size: 15px;
      margin-bottom: 15px;
    }

    .file-row {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0, 1fr));
      gap: 15px;
      margin-bottom: 18px;
    }

    .file-box {
      border: 1px solid #e5e7eb;
      border-radius: 9px;
      padding: 13px;
    }

    .file-box label {
      display: block;
      font-weight: 700;
      margin-bottom: 8px;
    }

    input[type="file"] {
      width: 100%;
    }

    .publish-btn {
      width: 100%;
      border: 0;
      background: #1877f2;
      color: white;
      padding: 14px;
      border-radius: 9px;
      font-size: 16px;
      font-weight: 800;
      cursor: pointer;
    }

    .publish-btn:hover,
    .connect-btn:hover {
      opacity: .92;
    }

    @media (max-width: 700px) {
      .file-row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>

<div class="container">

  <div class="topbar">
    <div>
      <h1>Meta Multi Page Publisher</h1>
      <div class="subtitle">
        Connect Facebook accounts and publish to multiple Pages.
      </div>
    </div>

    <a
      class="connect-btn"
      href="/auth/meta"
    >
      + Connect Facebook Account
    </a>
  </div>

  <div class="stats">

    <div class="stat">
      <div class="stat-number">
        ${accounts.length}
      </div>
      <div class="stat-label">
        Connected Facebook Accounts
      </div>
    </div>

    <div class="stat">
      <div class="stat-number">
        ${pages.length}
      </div>
      <div class="stat-label">
        Connected Pages
      </div>
    </div>

  </div>


  <!-- IMPORTANT:
       The publish form starts BEFORE the account cards.
       Therefore every page checkbox is physically INSIDE
       the same form and native form submission sends
       all checked page_ids.
  -->

  <form
    method="POST"
    action="/publish"
    enctype="multipart/form-data"
    id="publish-form"
  >

    ${accountCards}


    <div class="publisher">

      <h2>Create Post</h2>

      <input
        id="page-search"
        class="search-box"
        type="text"
        placeholder="Search Pages..."
        autocomplete="off"
      >

      <div class="select-actions">

        <button
          type="button"
          class="small-btn"
          id="select-all"
        >
          Select All
        </button>

        <button
          type="button"
          class="small-btn"
          id="clear-all"
        >
          Clear All
        </button>

      </div>

      <textarea
        name="message"
        placeholder="Write your post..."
      ></textarea>

      <div class="file-row">

        <div class="file-box">
          <label for="image">
            Image
          </label>

          <input
            id="image"
            type="file"
            name="image"
            accept="image/*"
          >
        </div>

        <div class="file-box">
          <label for="video">
            Video
          </label>

          <input
            id="video"
            type="file"
            name="video"
            accept="video/*"
          >
        </div>

      </div>

      <button
        type="submit"
        class="publish-btn"
      >
        Publish to Selected Pages
      </button>

    </div>

  </form>

</div>


<script>

  const publishForm =
    document.getElementById("publish-form");

  const searchInput =
    document.getElementById("page-search");

  const selectAllButton =
    document.getElementById("select-all");

  const clearAllButton =
    document.getElementById("clear-all");


  searchInput.addEventListener(
    "input",
    function () {

      const query =
        this.value
          .toLowerCase()
          .trim();

      document
        .querySelectorAll(".page-item")
        .forEach(function (item) {

          const text =
            item.innerText
              .toLowerCase();

          item.style.display =
            !query || text.includes(query)
              ? ""
              : "none";
        });
    }
  );


  selectAllButton.addEventListener(
    "click",
    function () {

      document
        .querySelectorAll(
          '.page-checkbox'
        )
        .forEach(function (checkbox) {

          const item =
            checkbox.closest(
              ".page-item"
            );

          if (
            !item ||
            item.style.display !== "none"
          ) {
            checkbox.checked = true;
          }
        });
    }
  );


  clearAllButton.addEventListener(
    "click",
    function () {

      document
        .querySelectorAll(
          '.page-checkbox'
        )
        .forEach(function (checkbox) {
          checkbox.checked = false;
        });
    }
  );


  publishForm.addEventListener(
    "submit",
    function (event) {

      const selected =
        document.querySelectorAll(
          '.page-checkbox:checked'
        );

      if (selected.length === 0) {
        event.preventDefault();

        alert(
          "Please select at least one Facebook Page."
        );

        return;
      }

      const image =
        document.getElementById("image");

      const video =
        document.getElementById("video");

      if (
        image.files.length > 0 &&
        video.files.length > 0
      ) {
        event.preventDefault();

        alert(
          "Please select either an image or a video, not both."
        );
      }
    }
  );


  async function syncAccount(accountId) {

    if (
      !confirm(
        "Sync Pages for this Facebook account?"
      )
    ) {
      return;
    }

    const form =
      document.createElement("form");

    form.method = "POST";
    form.action = "/sync-pages";

    const input =
      document.createElement("input");

    input.type = "hidden";
    input.name = "account_id";
    input.value = accountId;

    form.appendChild(input);

    document.body.appendChild(form);

    form.submit();
  }


  async function removeAccount(accountId) {

    if (
      !confirm(
        "Remove this Facebook account and its connected Pages?"
      )
    ) {
      return;
    }

    const form =
      document.createElement("form");

    form.method = "POST";
    form.action = "/remove-account";

    const input =
      document.createElement("input");

    input.type = "hidden";
    input.name = "account_id";
    input.value = accountId;

    form.appendChild(input);

    document.body.appendChild(form);

    form.submit();
  }

</script>

</body>
</html>`;
}


/* =========================================================
   RESULT PAGE
========================================================= */

function publishResultsPage({
  success,
  title,
  message,
  results
}) {
  const resultRows =
    results.map(item => {

      if (item.success) {
        return `
          <div class="result success">
            <div>
              <strong>
                ${escapeHtml(item.page_name)}
              </strong>

              <div class="id">
                Page ID:
                ${escapeHtml(item.page_id)}
              </div>
            </div>

            <div>
              Published
            </div>
          </div>
        `;
      }

      return `
        <div class="result error">
          <div>
            <strong>
              ${escapeHtml(item.page_name)}
            </strong>

            <div class="id">
              Page ID:
              ${escapeHtml(item.page_id)}
            </div>

            <div class="error-text">
              ${escapeHtml(item.error || "Unknown error")}
            </div>
          </div>

          <div>
            Failed
          </div>
        </div>
      `;
    }).join("");

  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <title>${escapeHtml(title)}</title>

  <style>
    body {
      margin: 0;
      padding: 30px;
      background: #f4f6f8;
      font-family:
        Arial,
        Helvetica,
        sans-serif;
      color: #111827;
    }

    .box {
      max-width: 900px;
      margin: 30px auto;
      background: white;
      border-radius: 14px;
      padding: 25px;
      box-shadow:
        0 2px 15px rgba(0,0,0,.07);
    }

    h1 {
      margin-top: 0;
    }

    .message {
      color: #4b5563;
      margin-bottom: 20px;
    }

    .result {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-start;
      padding: 15px;
      border-radius: 9px;
      margin-bottom: 10px;
      border: 1px solid #e5e7eb;
    }

    .success {
      background: #f0fdf4;
      border-color: #bbf7d0;
    }

    .error {
      background: #fef2f2;
      border-color: #fecaca;
    }

    .id {
      color: #6b7280;
      font-size: 12px;
      margin-top: 5px;
    }

    .error-text {
      color: #b91c1c;
      margin-top: 8px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .back {
      display: inline-block;
      margin-top: 15px;
      padding: 11px 16px;
      background: #1877f2;
      color: white;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 700;
    }
  </style>
</head>

<body>

<div class="box">

  <h1>
    ${escapeHtml(title)}
  </h1>

  <div class="message">
    ${escapeHtml(message)}
  </div>

  ${resultRows}

  <a
    class="back"
    href="/"
  >
    ← Back to Dashboard
  </a>

</div>

</body>
</html>`,
    {
      status: success ? 200 : 400,
      headers: {
        "content-type":
          "text/html; charset=UTF-8"
      }
    }
  );
}


/* =========================================================
   GENERIC RESULT
========================================================= */

function htmlResult(title, message) {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >
  <title>${escapeHtml(title)}</title>

  <style>
    body {
      font-family: Arial, sans-serif;
      background: #f4f6f8;
      padding: 30px;
    }

    .box {
      max-width: 900px;
      margin: 40px auto;
      background: white;
      padding: 25px;
      border-radius: 12px;
      box-shadow:
        0 2px 12px rgba(0,0,0,.08);
    }

    a {
      display: inline-block;
      margin-top: 15px;
      background: #1877f2;
      color: white;
      padding: 10px 15px;
      border-radius: 7px;
      text-decoration: none;
    }

    pre {
      white-space: pre-wrap;
      word-break: break-word;
    }
  </style>
</head>

<body>

<div class="box">

  <h1>
    ${escapeHtml(title)}
  </h1>

  <div>
    ${message}
  </div>

  <a href="/">
    ← Back to Dashboard
  </a>

</div>

</body>
</html>`,
    {
      status: 400,
      headers: {
        "content-type":
          "text/html; charset=UTF-8"
      }
    }
  );
}


/* =========================================================
   ESCAPING
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function escapeHtmlAttr(value) {
  return escapeHtml(value);
}
```
