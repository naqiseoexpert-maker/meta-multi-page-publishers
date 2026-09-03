
export default {
  async fetch(request, env) {
    try {
      await ensureAccountNameColumn(env.DB);

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return await showDashboard(env);
      }

      if (request.method === "GET" && url.pathname === "/auth/meta") {
        return startMetaLogin(request, env);
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
        return await publishPost(request, env);
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error(error);

      return page(
        "Server Error",
        `<pre>${escapeHtml(error?.stack || String(error))}</pre>`
      );
    }
  }
};


/* =========================================================
   DASHBOARD
========================================================= */

async function showDashboard(env) {
  const accountsResult = await env.DB.prepare(`
    SELECT id, facebook_user_id, account_name, access_token
    FROM accounts
    ORDER BY id ASC
  `).all();

  const accounts = accountsResult.results || [];

  for (const account of accounts) {
    try {
      const me = await facebookMe(account.access_token, env);

      if (me?.name && me.name !== account.account_name) {
        await env.DB.prepare(`
          UPDATE accounts
          SET account_name = ?
          WHERE id = ?
        `)
          .bind(me.name, account.id)
          .run();

        account.account_name = me.name;
      }
    } catch (error) {
      console.log("Account name refresh failed", error);
    }
  }

  const pagesResult = await env.DB.prepare(`
    SELECT id, facebook_page_id, page_name, access_token, account_id
    FROM pages
    ORDER BY account_id ASC, page_name ASC
  `).all();

  const pages = pagesResult.results || [];

  const accountHtml = accounts.map((account, index) => {
    const accountPages = pages.filter(
      p => Number(p.account_id) === Number(account.id)
    );

    const accountName =
      account.account_name ||
      `Facebook Account ${index + 1}`;

    return `
      <div class="account">

        <div class="account-header">

          <div>
            <h2>${escapeHtml(accountName)}</h2>

            <div class="muted">
              Facebook ID:
              ${escapeHtml(account.facebook_user_id)}
            </div>

            <div class="count">
              ${accountPages.length} Connected Pages
            </div>
          </div>

          <div class="actions">

            <button
              type="button"
              onclick="syncAccount(${Number(account.id)})"
            >
              Sync Pages
            </button>

            <button
              type="button"
              class="danger"
              onclick="removeAccount(${Number(account.id)})"
            >
              Remove
            </button>

          </div>

        </div>

        <div class="pages">

          ${
            accountPages.length
              ? accountPages.map(p => `
                <label class="page">

                  <input
                    type="checkbox"
                    name="page_ids"
                    value="${escapeHtml(p.facebook_page_id)}"
                    class="page-checkbox"
                  >

                  <span>
                    <strong>
                      ${escapeHtml(p.page_name || "Unnamed Page")}
                    </strong>

                    <small>
                      ${escapeHtml(p.facebook_page_id)}
                    </small>
                  </span>

                </label>
              `).join("")
              : `<div class="muted">No Pages Found</div>`
          }

        </div>

      </div>
    `;
  }).join("");


  return new Response(`
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">

<title>Meta Multi Page Publisher</title>

<style>

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: #f3f4f6;
  font-family: Arial, sans-serif;
  color: #111827;
}

.container {
  width: 94%;
  max-width: 1400px;
  margin: 30px auto 60px;
}

.top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 15px;
  flex-wrap: wrap;
  margin-bottom: 25px;
}

h1 {
  margin: 0;
}

.subtitle {
  color: #6b7280;
  margin-top: 6px;
}

.connect {
  background: #1877f2;
  color: white;
  padding: 12px 18px;
  border-radius: 8px;
  text-decoration: none;
  font-weight: bold;
}

.stats {
  display: flex;
  gap: 15px;
  margin-bottom: 20px;
}

.stat {
  background: white;
  padding: 15px 20px;
  border-radius: 10px;
  box-shadow: 0 2px 8px rgba(0,0,0,.06);
}

.stat strong {
  font-size: 25px;
  display: block;
}

.account {
  background: white;
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 20px;
  box-shadow: 0 2px 10px rgba(0,0,0,.06);
}

.account-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 15px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}

.account h2 {
  margin: 0 0 5px;
}

.muted {
  color: #6b7280;
  font-size: 13px;
}

.count {
  margin-top: 7px;
  font-weight: bold;
  font-size: 13px;
}

.actions {
  display: flex;
  gap: 8px;
}

button {
  border: 0;
  border-radius: 7px;
  padding: 9px 13px;
  cursor: pointer;
  font-weight: bold;
}

.danger {
  background: #fee2e2;
  color: #b91c1c;
}

.pages {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 10px;
}

.page {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  cursor: pointer;
}

.page:hover {
  border-color: #1877f2;
  background: #f8fbff;
}

.page input {
  margin-top: 3px;
  transform: scale(1.2);
}

.page small {
  display: block;
  color: #9ca3af;
  font-size: 11px;
  margin-top: 4px;
  word-break: break-all;
}

.publisher {
  background: white;
  border-radius: 12px;
  padding: 22px;
  box-shadow: 0 2px 10px rgba(0,0,0,.06);
}

.publisher h2 {
  margin-top: 0;
}

.search {
  width: 100%;
  padding: 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 15px;
}

.tools {
  display: flex;
  gap: 8px;
  margin-bottom: 15px;
}

.tools button {
  background: #eef2f7;
}

textarea {
  width: 100%;
  min-height: 150px;
  padding: 13px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  resize: vertical;
  font-family: Arial, sans-serif;
  font-size: 15px;
  margin-bottom: 15px;
}

.files {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 15px;
  margin-bottom: 18px;
}

.file {
  border: 1px solid #e5e7eb;
  padding: 13px;
  border-radius: 8px;
}

.file label {
  display: block;
  font-weight: bold;
  margin-bottom: 8px;
}

.publish {
  width: 100%;
  background: #1877f2;
  color: white;
  padding: 14px;
  font-size: 16px;
}

@media(max-width:700px) {
  .files {
    grid-template-columns: 1fr;
  }
}

</style>

</head>

<body>

<div class="container">

  <div class="top">

    <div>
      <h1>Meta Multi Page Publisher</h1>

      <div class="subtitle">
        Connect Facebook accounts and publish to multiple Pages.
      </div>
    </div>

    <a class="connect" href="/auth/meta">
      + Connect Facebook Account
    </a>

  </div>


  <div class="stats">

    <div class="stat">
      <strong>${accounts.length}</strong>
      Connected Facebook Accounts
    </div>

    <div class="stat">
      <strong>${pages.length}</strong>
      Connected Pages
    </div>

  </div>


  <!-- ONE SINGLE FORM -->
  <!-- ALL PAGE CHECKBOXES ARE INSIDE THIS FORM -->

  <form
    id="publish-form"
    method="POST"
    action="/publish"
    enctype="multipart/form-data"
  >

    ${accountHtml}


    <div class="publisher">

      <h2>Create Post</h2>

      <input
        id="search"
        class="search"
        type="text"
        placeholder="Search Pages..."
      >

      <div class="tools">

        <button
          type="button"
          onclick="selectAll()"
        >
          Select All
        </button>

        <button
          type="button"
          onclick="clearAll()"
        >
          Clear All
        </button>

      </div>


      <textarea
        name="message"
        placeholder="Write your post..."
      ></textarea>


      <div class="files">

        <div class="file">

          <label>
            Image
          </label>

          <input
            id="image"
            type="file"
            name="image"
            accept="image/*"
          >

        </div>


        <div class="file">

          <label>
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
        class="publish"
      >
        Publish to Selected Pages
      </button>

    </div>

  </form>

</div>


<script>

const form =
  document.getElementById("publish-form");

const search =
  document.getElementById("search");


search.addEventListener("input", function() {

  const value =
    this.value.toLowerCase().trim();

  document
    .querySelectorAll(".page")
    .forEach(function(item) {

      const text =
        item.innerText.toLowerCase();

      item.style.display =
        !value || text.includes(value)
          ? ""
          : "none";

    });

});


function selectAll() {

  document
    .querySelectorAll(".page-checkbox")
    .forEach(function(box) {

      const item =
        box.closest(".page");

      if (
        item &&
        item.style.display !== "none"
      ) {
        box.checked = true;
      }

    });

}


function clearAll() {

  document
    .querySelectorAll(".page-checkbox")
    .forEach(function(box) {
      box.checked = false;
    });

}


form.addEventListener("submit", function(event) {

  const selected =
    document.querySelectorAll(
      ".page-checkbox:checked"
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
      "Please select either Image OR Video, not both."
    );

  }

});


function syncAccount(id) {

  if (!confirm("Sync Pages for this account?")) {
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
  input.value = id;

  form.appendChild(input);
  document.body.appendChild(form);

  form.submit();

}


function removeAccount(id) {

  if (
    !confirm(
      "Remove this Facebook account and its Pages?"
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
  input.value = id;

  form.appendChild(input);
  document.body.appendChild(form);

  form.submit();

}

</script>

</body>
</html>
  `, {
    headers: {
      "content-type": "text/html; charset=UTF-8"
    }
  });
}


/* =========================================================
   META LOGIN
========================================================= */

function startMetaLogin(request, env) {
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

  const code =
    url.searchParams.get("code");

  if (!code) {
    return page(
      "Facebook Login Error",
      "Authorization code was not returned."
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

  if (
    !tokenResponse.ok ||
    !tokenData.access_token
  ) {
    return page(
      "Facebook Token Error",
      `<pre>${escapeHtml(
        JSON.stringify(tokenData, null, 2)
      )}</pre>`
    );
  }

  const userToken =
    tokenData.access_token;

  const me =
    await facebookMe(
      userToken,
      env
    );

  if (!me?.id) {
    return page(
      "Facebook Error",
      "Could not get Facebook account ID."
    );
  }

  const accountName =
    me.name ||
    `Facebook Account ${me.id}`;


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
      SET account_name = ?, access_token = ?
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
        (
          facebook_user_id,
          account_name,
          access_token,
          created_at
        )
        VALUES (?, ?, ?, datetime('now'))
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

    const pages =
      await getFacebookPages(
        userToken,
        env
      );

    for (const p of pages) {
      await savePage(
        env.DB,
        accountId,
        p
      );
    }

  } catch (error) {
    console.error(
      "Page sync after login failed",
      error
    );
  }


  return Response.redirect(
    `${url.origin}/`,
    303
  );
}


/* =========================================================
   SYNC
========================================================= */

async function syncPages(request, env) {
  const form =
    await request.formData();

  const accountId =
    form.get("account_id");

  if (!accountId) {
    return page(
      "Sync Error",
      "Account ID is missing."
    );
  }


  const account =
    await env.DB.prepare(`
      SELECT id, access_token
      FROM accounts
      WHERE id = ?
      LIMIT 1
    `)
      .bind(Number(accountId))
      .first();


  if (!account) {
    return page(
      "Sync Error",
      "Account not found."
    );
  }


  const me =
    await facebookMe(
      account.access_token,
      env
    );


  if (me?.name) {
    await env.DB.prepare(`
      UPDATE accounts
      SET account_name = ?
      WHERE id = ?
    `)
      .bind(
        me.name,
        account.id
      )
      .run();
  }


  const pages =
    await getFacebookPages(
      account.access_token,
      env
    );


  for (const p of pages) {
    await savePage(
      env.DB,
      account.id,
      p
    );
  }


  return Response.redirect(
    new URL("/", request.url).toString(),
    303
  );
}


/* =========================================================
   REMOVE ACCOUNT
========================================================= */

async function removeAccount(request, env) {
  const form =
    await request.formData();

  const accountId =
    form.get("account_id");

  if (!accountId) {
    return page(
      "Remove Error",
      "Account ID is missing."
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

async function publishPost(request, env) {
  const form =
    await request.formData();


  const message =
    String(
      form.get("message") || ""
    ).trim();


  const pageIds =
    form
      .getAll("page_ids")
      .map(x => String(x).trim())
      .filter(Boolean);


  const image =
    form.get("image");


  const video =
    form.get("video");


  /*
    IMPORTANT DEBUG:
    If browser sends zero page IDs, this will show
    exactly that instead of silently failing.
  */

  if (pageIds.length === 0) {

    return publishResult(
      "No Pages Selected",
      "The browser submitted 0 page_ids. Select a Page and try again.",
      []
    );
  }


  const hasImage =
    image instanceof File &&
    image.size > 0;


  const hasVideo =
    video instanceof File &&
    video.size > 0;


  if (
    !message &&
    !hasImage &&
    !hasVideo
  ) {

    return publishResult(
      "Empty Post",
      "Write a message or select an image/video.",
      []
    );
  }


  if (hasImage && hasVideo) {

    return publishResult(
      "Invalid Post",
      "Please select either Image OR Video.",
      []
    );
  }


  const placeholders =
    pageIds.map(() => "?").join(",");


  const result =
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
      .bind(...pageIds)
      .all();


  const pages =
    result.results || [];


  if (pages.length === 0) {

    return publishResult(
      "Pages Not Found",
      `Received ${pageIds.length} Page ID(s), but none matched the database.`,
      []
    );
  }


  const results = [];


  for (const p of pages) {

    try {

      let response;


      if (hasVideo) {

        response =
          await postVideo(
            p,
            message,
            video,
            env
          );

      } else if (hasImage) {

        response =
          await postImage(
            p,
            message,
            image,
            env
          );

      } else {

        response =
          await postText(
            p,
            message,
            env
          );

      }


      results.push({
        page_name:
          p.page_name || "Unnamed Page",

        page_id:
          p.facebook_page_id,

        success: true,

        response
      });


    } catch (error) {

      results.push({
        page_name:
          p.page_name || "Unnamed Page",

        page_id:
          p.facebook_page_id,

        success: false,

        error:
          error?.message || String(error)
      });

    }

  }


  const successCount =
    results.filter(
      r => r.success
    ).length;


  let title;

  if (successCount === results.length) {
    title = "Published Successfully";
  } else if (successCount > 0) {
    title = "Partially Published";
  } else {
    title = "Publish Failed";
  }


  return publishResult(
    title,
    `${successCount} of ${results.length} selected Pages published successfully.`,
    results
  );
}


/* =========================================================
   TEXT
========================================================= */

async function postText(pageData, message, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(pageData.facebook_page_id)}/feed`;


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
            pageData.access_token
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
   IMAGE
========================================================= */

async function postImage(pageData, message, image, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(pageData.facebook_page_id)}/photos`;


  const body =
    new FormData();


  body.append(
    "access_token",
    pageData.access_token
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
   VIDEO
========================================================= */

async function postVideo(pageData, message, video, env) {
  const url =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${encodeURIComponent(pageData.facebook_page_id)}/videos`;


  const body =
    new FormData();


  body.append(
    "access_token",
    pageData.access_token
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
   FACEBOOK
========================================================= */

async function facebookMe(accessToken, env) {
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


async function getFacebookPages(accessToken, env) {
  const pages = [];


  let next =
    `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
    `?fields=id,name,access_token` +
    `&limit=100` +
    `&access_token=${encodeURIComponent(accessToken)}`;


  while (next) {

    const response =
      await fetch(next);


    const data =
      await response.json();


    if (!response.ok || data.error) {
      throw new Error(
        data.error?.message ||
        JSON.stringify(data)
      );
    }


    if (Array.isArray(data.data)) {
      pages.push(...data.data);
    }


    next =
      data.paging?.next || null;
  }


  return pages;
}


/* =========================================================
   DATABASE
========================================================= */

async function ensureAccountNameColumn(db) {
  try {

    await db.prepare(`
      ALTER TABLE accounts
      ADD COLUMN account_name TEXT
    `).run();

  } catch (error) {

    const text =
      String(error?.message || error)
        .toLowerCase();

    if (
      !text.includes("duplicate") &&
      !text.includes("already exists")
    ) {
      console.log(
        "account_name column check:",
        error
      );
    }
  }
}


async function savePage(db, accountId, pageData) {
  const existing =
    await db.prepare(`
      SELECT id
      FROM pages
      WHERE facebook_page_id = ?
      LIMIT 1
    `)
      .bind(String(pageData.id))
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
        pageData.name || "Unnamed Page",
        pageData.access_token,
        Number(accountId),
        String(pageData.id)
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
      VALUES (?, ?, ?, ?)
    `)
      .bind(
        String(pageData.id),
        pageData.name || "Unnamed Page",
        pageData.access_token,
        Number(accountId)
      )
      .run();
  }
}


/* =========================================================
   RESULT
========================================================= */

function publishResult(title, message, results) {

  const rows =
    results.map(r => {

      if (r.success) {

        return `
          <div class="row ok">

            <div>
              <strong>
                ${escapeHtml(r.page_name)}
              </strong>

              <small>
                Page ID:
                ${escapeHtml(r.page_id)}
              </small>
            </div>

            <strong>
              Published
            </strong>

          </div>
        `;

      }


      return `
        <div class="row bad">

          <div>
            <strong>
              ${escapeHtml(r.page_name)}
            </strong>

            <small>
              Page ID:
              ${escapeHtml(r.page_id)}
            </small>

            <div class="error">
              ${escapeHtml(r.error)}
            </div>
          </div>

          <strong>
            Failed
          </strong>

        </div>
      `;

    }).join("");


  return new Response(`
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>${escapeHtml(title)}</title>

<style>

body {
  margin: 0;
  background: #f3f4f6;
  font-family: Arial, sans-serif;
  padding: 30px;
}

.box {
  max-width: 900px;
  margin: 30px auto;
  background: white;
  padding: 25px;
  border-radius: 12px;
  box-shadow: 0 2px 12px rgba(0,0,0,.08);
}

.row {
  padding: 15px;
  margin-top: 10px;
  border-radius: 8px;
  display: flex;
  justify-content: space-between;
  gap: 15px;
}

.ok {
  background: #ecfdf5;
  border: 1px solid #bbf7d0;
}

.bad {
  background: #fef2f2;
  border: 1px solid #fecaca;
}

small {
  display: block;
  color: #6b7280;
  margin-top: 5px;
}

.error {
  color: #b91c1c;
  margin-top: 8px;
  white-space: pre-wrap;
}

.back {
  display: inline-block;
  margin-top: 20px;
  background: #1877f2;
  color: white;
  padding: 11px 16px;
  border-radius: 8px;
  text-decoration: none;
  font-weight: bold;
}

</style>

</head>

<body>

<div class="box">

<h1>
${escapeHtml(title)}
</h1>

<p>
${escapeHtml(message)}
</p>

${rows}

<a class="back" href="/">
← Back to Dashboard
</a>

</div>

</body>
</html>
  `, {
    status: title === "No Pages Selected" ? 400 : 200,

    headers: {
      "content-type":
        "text/html; charset=UTF-8"
    }
  });
}


/* =========================================================
   GENERIC PAGE
========================================================= */

function page(title, content) {
  return new Response(`
<!DOCTYPE html>
<html>
<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>${escapeHtml(title)}</title>

<style>

body {
  margin: 0;
  padding: 30px;
  background: #f3f4f6;
  font-family: Arial, sans-serif;
}

.box {
  max-width: 900px;
  margin: 40px auto;
  background: white;
  padding: 25px;
  border-radius: 12px;
}

a {
  display: inline-block;
  margin-top: 20px;
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
${content}
</div>

<a href="/">
← Back to Dashboard
</a>

</div>

</body>
</html>
  `, {
    status: 400,

    headers: {
      "content-type":
        "text/html; charset=UTF-8"
    }
  });
}


/* =========================================================
   ESCAPE
========================================================= */

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

