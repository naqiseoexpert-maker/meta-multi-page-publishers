export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================================================
    // ENVIRONMENT VARIABLE CHECK
    // =========================================================

    if (
      !env.META_APP_ID ||
      !env.META_APP_SECRET ||
      !env.META_GRAPH_VERSION ||
      !env.DB
    ) {
      return new Response(
        `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Configuration Error</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
        </head>

        <body style="font-family:Arial;padding:30px">

          <h2>❌ Configuration Error</h2>

          <p>
            One or more Cloudflare Worker variables are missing.
          </p>

          <ul>
            <li>
              META_APP_ID:
              <strong>
                ${env.META_APP_ID ? "OK" : "MISSING"}
              </strong>
            </li>

            <li>
              META_APP_SECRET:
              <strong>
                ${env.META_APP_SECRET ? "OK" : "MISSING"}
              </strong>
            </li>

            <li>
              META_GRAPH_VERSION:
              <strong>
                ${env.META_GRAPH_VERSION ? "OK" : "MISSING"}
              </strong>
            </li>

            <li>
              DB:
              <strong>
                ${env.DB ? "OK" : "MISSING"}
              </strong>
            </li>
          </ul>

          <p>
            Go to Cloudflare → Worker → Settings →
            Variables and Secrets.
          </p>

        </body>
        </html>
        `,
        {
          status: 500,
          headers: {
            "content-type": "text/html;charset=UTF-8"
          }
        }
      );
    }


    // =========================================================
    // HOME / DASHBOARD
    // =========================================================

    if (url.pathname === "/") {

      // -------------------------------------------------------
      // GET ALL FACEBOOK ACCOUNTS
      // -------------------------------------------------------

      const accountsResult =
        await env.DB.prepare(`
          SELECT
            id,
            facebook_user_id
          FROM facebook_accounts
          ORDER BY id DESC
        `).all();


      const accounts =
        accountsResult.results || [];


      // -------------------------------------------------------
      // GET ALL PAGES
      // -------------------------------------------------------

      const pagesResult =
        await env.DB.prepare(`
          SELECT
            facebook_pages.id,
            facebook_pages.page_id,
            facebook_pages.page_name,
            facebook_pages.account_id,
            facebook_accounts.facebook_user_id
          FROM facebook_pages
          JOIN facebook_accounts
            ON facebook_pages.account_id =
               facebook_accounts.id
          ORDER BY
            facebook_accounts.id DESC,
            facebook_pages.page_name ASC
        `).all();


      const allPages =
        pagesResult.results || [];


      // =======================================================
      // GROUP PAGES BY FACEBOOK ACCOUNT
      // =======================================================

      const accountGroups = {};


      // -------------------------------------------------------
      // FIRST CREATE ALL ACCOUNTS
      // -------------------------------------------------------

      for (const account of accounts) {

        const accountId =
          String(account.id);


        accountGroups[accountId] = {
          facebook_user_id:
            account.facebook_user_id,

          pages: []
        };

      }


      // -------------------------------------------------------
      // THEN ADD PAGES
      // -------------------------------------------------------

      for (const page of allPages) {

        const accountId =
          String(page.account_id);


        if (!accountGroups[accountId]) {

          accountGroups[accountId] = {
            facebook_user_id:
              page.facebook_user_id,

            pages: []
          };

        }


        accountGroups[accountId].pages.push(page);

      }


      // =======================================================
      // BUILD ACCOUNT HTML
      // =======================================================

      let accountHtml = "";


      for (
        const [accountId, account]
        of Object.entries(accountGroups)
      ) {

        const groupPages =
          account.pages;


        const pageRows =
          groupPages
            .map(
              (page) => `
                <tr
                  class="page-row"
                  data-page-name="${escapeHtml(
                    String(page.page_name)
                      .toLowerCase()
                  )}"
                  data-page-id="${escapeHtml(
                    page.page_id
                  )}"
                >

                  <td>

                    <input
                      type="checkbox"
                      class="page-checkbox account-${escapeHtml(
                        accountId
                      )}"
                      name="page_ids"
                      value="${escapeHtml(
                        page.page_id
                      )}"
                    >

                  </td>


                  <td>

                    <strong>
                      ${escapeHtml(
                        page.page_name
                      )}
                    </strong>

                  </td>


                  <td>

                    ${escapeHtml(
                      page.page_id
                    )}

                  </td>

                </tr>
              `
            )
            .join("");


        accountHtml += `
          <div
            class="account-box"
            data-account-id="${escapeHtml(
              accountId
            )}"
          >

            <div class="account-header">

              <div>

                <div class="account-title">
                  👤 Facebook Account
                </div>

                <div class="account-id">
                  ${escapeHtml(
                    account.facebook_user_id
                  )}
                </div>

                <div class="page-count">
                  ${groupPages.length}
                  Page${
                    groupPages.length === 1
                      ? ""
                      : "s"
                  }
                </div>

              </div>


              <div class="account-actions">

                <button
                  type="button"
                  class="small-button"
                  onclick="selectAccount('${escapeHtml(
                    accountId
                  )}')"
                >
                  ☑️ Select Account
                </button>


                <button
                  type="button"
                  class="small-button gray"
                  onclick="unselectAccount('${escapeHtml(
                    accountId
                  )}')"
                >
                  ⬜ Unselect
                </button>


                <form
                  method="POST"
                  action="/sync-pages"
                  style="display:inline"
                  onsubmit="return syncAccount(this);"
                >

                  <input
                    type="hidden"
                    name="account_id"
                    value="${escapeHtml(accountId)}"
                  >

                  <button
                    type="submit"
                    class="small-button sync-button"
                  >
                    🔄 Sync Pages
                  </button>

                </form>


                <form
                  method="POST"
                  action="/remove-account"
                  style="display:inline"
                  onsubmit="return confirm('Is Facebook account aur is ke tamam Pages ko remove karna hai?');"
                >

                  <input
                    type="hidden"
                    name="account_id"
                    value="${escapeHtml(accountId)}"
                  >

                  <button
                    type="submit"
                    class="small-button remove-button"
                  >
                    🗑️ Remove Account
                  </button>

                </form>

              </div>

            </div>


            ${
              groupPages.length
                ? `
                  <table>

                    <thead>

                      <tr>

                        <th style="width:70px">
                          Select
                        </th>

                        <th>
                          Page Name
                        </th>

                        <th>
                          Page ID
                        </th>

                      </tr>

                    </thead>


                    <tbody>

                      ${pageRows}

                    </tbody>

                  </table>
                `
                : `
                  <div
                    style="
                      padding:20px;
                      color:#6b7280;
                      background:#fafafa;
                    "
                  >
                    No Pages connected yet.
                    Click <strong>🔄 Sync Pages</strong>
                    to load this account's Facebook Pages.
                  </div>
                `
            }

          </div>
        `;

      }


      // =======================================================
      // DASHBOARD HTML
      // =======================================================

      return new Response(
        `
        <!DOCTYPE html>

        <html>

        <head>

          <title>
            Meta Multi Page Publisher
          </title>


          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >


          <style>

            * {
              box-sizing: border-box;
            }


            body {
              font-family: Arial, sans-serif;
              padding: 20px;
              background: #f5f7fb;
              margin: 0;
              color: #111827;
            }


            .box {
              background: white;
              padding: 25px;
              border-radius: 14px;
              max-width: 1200px;
              margin: auto;
              box-shadow:
                0 2px 12px rgba(0,0,0,.06);
            }


            h2 {
              margin-top: 0;
            }


            h3 {
              margin-top: 0;
            }


            .top-bar {
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 15px;
              flex-wrap: wrap;
            }


            .button {
              display: inline-block;
              background: #1877f2;
              color: white;
              padding: 12px 18px;
              border-radius: 8px;
              text-decoration: none;
              border: none;
              cursor: pointer;
              font-size: 15px;
            }


            .button:disabled,
            .small-button:disabled {
              opacity: .6;
              cursor: not-allowed;
            }


            .publish-button {
              background: #16a34a;
              margin-top: 20px;
              width: 100%;
              font-size: 17px;
              padding: 14px;
            }


            .stats {
              background: #eff6ff;
              padding: 15px;
              border-radius: 10px;
              margin-top: 20px;
              line-height: 1.8;
            }


            .post-box {
              margin-top: 25px;
              padding: 20px;
              background: #f8fafc;
              border-radius: 12px;
              border: 1px solid #e5e7eb;
            }


            textarea {
              width: 100%;
              min-height: 130px;
              padding: 12px;
              border: 1px solid #ccc;
              border-radius: 8px;
              font-family: Arial;
              font-size: 15px;
              resize: vertical;
            }


            input[type="file"] {
              width: 100%;
              margin-top: 8px;
              margin-bottom: 12px;
            }


            .media-box {
              margin-top: 18px;
              padding: 15px;
              background: white;
              border: 1px solid #ddd;
              border-radius: 10px;
            }


            .media-label {
              display: block;
              font-weight: bold;
              margin-top: 10px;
            }


            .toolbar {
              margin-top: 25px;
              padding: 15px;
              background: #f8fafc;
              border-radius: 10px;
              border: 1px solid #e5e7eb;
            }


            .toolbar-row {
              display: flex;
              gap: 10px;
              flex-wrap: wrap;
              margin-top: 12px;
            }


            .small-button {
              border: none;
              background: #1877f2;
              color: white;
              padding: 8px 12px;
              border-radius: 7px;
              cursor: pointer;
            }


            .small-button.gray {
              background: #6b7280;
            }


            .sync-button {
              background: #7c3aed;
            }


            .remove-button {
              background: #dc2626;
            }


            .search {
              width: 100%;
              padding: 12px;
              border: 1px solid #ccc;
              border-radius: 8px;
              font-size: 15px;
              margin-top: 10px;
            }


            .account-box {
              margin-top: 20px;
              border: 1px solid #ddd;
              border-radius: 12px;
              overflow: hidden;
              background: white;
            }


            .account-header {
              padding: 15px;
              background: #f0f2f5;
              display: flex;
              justify-content: space-between;
              align-items: center;
              gap: 15px;
              flex-wrap: wrap;
            }


            .account-title {
              font-weight: bold;
              font-size: 16px;
            }


            .account-id {
              margin-top: 5px;
              font-size: 13px;
              color: #4b5563;
              word-break: break-all;
            }


            .page-count {
              margin-top: 4px;
              font-size: 13px;
              color: #6b7280;
            }


            .account-actions {
              display: flex;
              gap: 8px;
              flex-wrap: wrap;
            }


            table {
              width: 100%;
              border-collapse: collapse;
            }


            th,
            td {
              padding: 10px;
              border-bottom: 1px solid #e5e7eb;
              text-align: left;
            }


            th {
              background: #fafafa;
            }


            tr.page-row.hidden {
              display: none;
            }


            .selection-info {
              margin-top: 12px;
              font-weight: bold;
              color: #166534;
            }


            .hint {
              color: #6b7280;
              font-size: 13px;
              margin-top: 8px;
            }


            .warning {
              margin-top: 12px;
              padding: 10px;
              background: #fff7ed;
              border: 1px solid #fed7aa;
              border-radius: 8px;
              color: #9a3412;
              font-size: 13px;
            }


            @media (max-width: 700px) {

              body {
                padding: 10px;
              }


              .box {
                padding: 15px;
              }


              th,
              td {
                padding: 7px;
                font-size: 13px;
              }


              .account-actions {
                width: 100%;
              }


              .account-actions button,
              .account-actions form {
                width: 100%;
              }


              .account-actions form button {
                width: 100%;
              }


              .button {
                width: 100%;
                text-align: center;
              }

            }

          </style>

        </head>


        <body>

          <div class="box">


            <!-- =============================================
                 TOP BAR
            ============================================== -->

            <div class="top-bar">

              <div>

                <h2>
                  Meta Multi Page Publisher
                </h2>

                <div>
                  Manage all your Facebook Pages
                </div>

              </div>


              <a
                class="button"
                href="/auth/meta"
              >
                + Connect Facebook Account
              </a>

            </div>


            <!-- =============================================
                 STATS
            ============================================== -->

            <div class="stats">

              👤 Connected Facebook Accounts:
              <strong>
                ${accounts.length}
              </strong>


              &nbsp;&nbsp; | &nbsp;&nbsp;


              📄 Connected Pages:
              <strong>
                ${allPages.length}
              </strong>

            </div>


            ${
              allPages.length
                ? `

                <!-- =========================================
                     CREATE POST
                ========================================== -->

                <form
                  method="POST"
                  action="/publish"
                  enctype="multipart/form-data"
                  id="publishForm"
                >


                  <div class="post-box">

                    <h3>
                      📝 Create Post
                    </h3>


                    <label>

                      <strong>
                        Post Text
                      </strong>

                    </label>


                    <br><br>


                    <textarea
                      name="message"
                      placeholder="Write your Facebook post here..."
                    ></textarea>


                    <div class="media-box">


                      <label class="media-label">

                        🖼️ Image
                        <span style="font-weight:normal">
                          (optional)
                        </span>

                      </label>


                      <input
                        type="file"
                        name="image"
                        id="imageInput"
                        accept="image/*"
                      >


                      <label class="media-label">

                        🎥 Video
                        <span style="font-weight:normal">
                          (optional)
                        </span>

                      </label>


                      <input
                        type="file"
                        name="video"
                        id="videoInput"
                        accept="video/*"
                      >


                      <div class="hint">

                        Select either an image or a video.

                      </div>


                      <div class="warning">

                        ⚠️ Image + Video ek saath select
                        na karein.

                      </div>

                    </div>

                  </div>


                  <!-- =======================================
                       PAGE CONTROLS
                  ======================================== -->

                  <div class="toolbar">

                    <h3>
                      📄 Select Pages
                    </h3>


                    <input
                      id="pageSearch"
                      class="search"
                      type="text"
                      placeholder="🔍 Search Page Name or Page ID..."
                      oninput="searchPages()"
                    >


                    <div class="toolbar-row">


                      <button
                        type="button"
                        class="small-button"
                        onclick="selectAllPages()"
                      >
                        ☑️ Select All
                      </button>


                      <button
                        type="button"
                        class="small-button gray"
                        onclick="unselectAllPages()"
                      >
                        ⬜ Unselect All
                      </button>


                    </div>


                    <div
                      class="selection-info"
                      id="selectionInfo"
                    >
                      0 Pages Selected
                    </div>

                  </div>


                  <!-- =======================================
                       ACCOUNTS / PAGES
                  ======================================== -->

                  <div id="accountsContainer">

                    ${accountHtml}

                  </div>


                  <!-- =======================================
                       PUBLISH
                  ======================================== -->

                  <button
                    class="button publish-button"
                    type="submit"
                    id="publishButton"
                  >
                    🚀 Publish to Selected Pages
                  </button>


                </form>


                <script>

                  // =================================================
                  // GET CHECKBOXES
                  // =================================================

                  function getPageCheckboxes() {

                    return document.querySelectorAll(
                      'input[name="page_ids"]'
                    );

                  }


                  // =================================================
                  // UPDATE SELECTION COUNT
                  // =================================================

                  function updateSelectionCount() {

                    const checkboxes =
                      getPageCheckboxes();


                    let count = 0;


                    checkboxes.forEach(
                      function(cb) {

                        if (cb.checked) {
                          count++;
                        }

                      }
                    );


                    const info =
                      document.getElementById(
                        "selectionInfo"
                      );


                    if (info) {

                      info.textContent =
                        count +
                        " Page" +
                        (
                          count === 1
                            ? ""
                            : "s"
                        ) +
                        " Selected";

                    }

                  }


                  // =================================================
                  // SELECT ALL
                  // =================================================

                  function selectAllPages() {

                    getPageCheckboxes()
                      .forEach(
                        function(cb) {

                          cb.checked = true;

                        }
                      );


                    updateSelectionCount();

                  }


                  // =================================================
                  // UNSELECT ALL
                  // =================================================

                  function unselectAllPages() {

                    getPageCheckboxes()
                      .forEach(
                        function(cb) {

                          cb.checked = false;

                        }
                      );


                    updateSelectionCount();

                  }


                  // =================================================
                  // SELECT ACCOUNT
                  // =================================================

                  function selectAccount(
                    accountId
                  ) {

                    document
                      .querySelectorAll(
                        ".account-" +
                        CSS.escape(accountId)
                      )
                      .forEach(
                        function(cb) {

                          cb.checked = true;

                        }
                      );


                    updateSelectionCount();

                  }


                  // =================================================
                  // UNSELECT ACCOUNT
                  // =================================================

                  function unselectAccount(
                    accountId
                  ) {

                    document
                      .querySelectorAll(
                        ".account-" +
                        CSS.escape(accountId)
                      )
                      .forEach(
                        function(cb) {

                          cb.checked = false;

                        }
                      );


                    updateSelectionCount();

                  }


                  // =================================================
                  // SEARCH PAGES
                  // =================================================

                  function searchPages() {

                    const input =
                      document.getElementById(
                        "pageSearch"
                      );


                    const search =
                      input
                        ? input.value
                            .toLowerCase()
                            .trim()
                        : "";


                    document
                      .querySelectorAll(
                        ".page-row"
                      )
                      .forEach(
                        function(row) {

                          const pageName =
                            (
                              row.dataset.pageName ||
                              ""
                            ).toLowerCase();


                          const pageId =
                            (
                              row.dataset.pageId ||
                              ""
                            ).toLowerCase();


                          if (
                            pageName.includes(search) ||
                            pageId.includes(search)
                          ) {

                            row.classList.remove(
                              "hidden"
                            );

                          } else {

                            row.classList.add(
                              "hidden"
                            );

                          }

                        }
                      );

                  }


                  // =================================================
                  // CHECKBOX CHANGE
                  // =================================================

                  document.addEventListener(
                    "change",
                    function(event) {

                      if (
                        event.target.matches(
                          'input[name="page_ids"]'
                        )
                      ) {

                        updateSelectionCount();

                      }

                    }
                  );


                  // =================================================
                  // IMAGE / VIDEO CHECK
                  // =================================================

                  const imageInput =
                    document.getElementById(
                      "imageInput"
                    );


                  const videoInput =
                    document.getElementById(
                      "videoInput"
                    );


                  if (
                    imageInput &&
                    videoInput
                  ) {

                    imageInput.addEventListener(
                      "change",
                      function() {

                        if (
                          imageInput.files.length
                        ) {

                          videoInput.value = "";

                        }

                      }
                    );


                    videoInput.addEventListener(
                      "change",
                      function() {

                        if (
                          videoInput.files.length
                        ) {

                          imageInput.value = "";

                        }

                      }
                    );

                  }


                  // =================================================
                  // SYNC ACCOUNT
                  // =================================================

                  function syncAccount(
                    form
                  ) {

                    const button =
                      form.querySelector(
                        "button"
                      );


                    if (button) {

                      button.disabled =
                        true;

                      button.textContent =
                        "⏳ Syncing Pages...";

                    }


                    return true;

                  }


                  // =================================================
                  // FORM SUBMIT PROTECTION
                  // =================================================

                  const publishForm =
                    document.getElementById(
                      "publishForm"
                    );


                  const publishButton =
                    document.getElementById(
                      "publishButton"
                    );


                  if (
                    publishForm &&
                    publishButton
                  ) {

                    publishForm.addEventListener(
                      "submit",
                      function(event) {

                        const selected =
                          document.querySelectorAll(
                            'input[name="page_ids"]:checked'
                          );


                        if (
                          selected.length === 0
                        ) {

                          event.preventDefault();

                          alert(
                            "Please select at least one Facebook Page."
                          );

                          return;

                        }


                        publishButton.disabled =
                          true;


                        publishButton.textContent =
                          "⏳ Publishing... Please wait";

                      }
                    );

                  }


                  // =================================================
                  // INITIAL COUNT
                  // =================================================

                  updateSelectionCount();

                </script>

              `
                : `

                <div class="post-box">

                  <h3>
                    No Facebook Pages Connected
                  </h3>

                  <p>
                    Connect a Facebook account to load its Pages.
                  </p>

                  ${
                    accounts.length
                      ? `
                        <p>
                          Facebook account connected hai.
                          Dashboard se
                          <strong>🔄 Sync Pages</strong>
                          click karke Pages load karein.
                        </p>

                        <div id="accountsContainer">
                          ${accountHtml}
                        </div>
                      `
                      : ""
                  }

                </div>

              `
            }


          </div>

        </body>

        </html>
        `,
        {
          headers: {
            "content-type":
              "text/html;charset=UTF-8"
          }
        }
      );
    }


    // =========================================================
    // START FACEBOOK LOGIN
    // =========================================================

    if (
      url.pathname === "/auth/meta"
    ) {

      if (!env.META_APP_ID) {

        return new Response(
          "ERROR: META_APP_ID is missing in Cloudflare Worker Variables.",
          {
            status: 500
          }
        );

      }


      if (!env.META_GRAPH_VERSION) {

        return new Response(
          "ERROR: META_GRAPH_VERSION is missing in Cloudflare Worker Variables.",
          {
            status: 500
          }
        );

      }


      if (!env.META_APP_SECRET) {

        return new Response(
          "ERROR: META_APP_SECRET is missing in Cloudflare Worker Variables.",
          {
            status: 500
          }
        );

      }


      const redirectUri =
        `${url.origin}/auth/meta/callback`;


      const facebookUrl =
        `https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth` +
        `?client_id=${encodeURIComponent(
          env.META_APP_ID
        )}` +
        `&redirect_uri=${encodeURIComponent(
          redirectUri
        )}` +
        `&response_type=code` +
        `&scope=${encodeURIComponent(
          "pages_show_list,pages_read_engagement,pages_manage_posts"
        )}`;


      return Response.redirect(
        facebookUrl,
        302
      );

    }


    // =========================================================
    // FACEBOOK CALLBACK
    // =========================================================

    if (
      url.pathname ===
      "/auth/meta/callback"
    ) {

      const code =
        url.searchParams.get(
          "code"
        );


      const error =
        url.searchParams.get(
          "error"
        );


      const errorDescription =
        url.searchParams.get(
          "error_description"
        );


      if (error) {

        return new Response(
          `
          <!DOCTYPE html>

          <html>

          <body
            style="font-family:Arial;padding:30px"
          >

            <h2>
              ❌ Facebook Login Failed
            </h2>

            <p>
              ${escapeHtml(
                errorDescription ||
                error
              )}
            </p>

            <p>
              <a href="/">
                ← Back to Dashboard
              </a>
            </p>

          </body>

          </html>
          `,
          {
            status: 400,
            headers: {
              "content-type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }


      if (!code) {

        return new Response(
          "Missing Facebook authorization code.",
          {
            status: 400
          }
        );

      }


      const redirectUri =
        `${url.origin}/auth/meta/callback`;


      // =======================================================
      // EXCHANGE CODE FOR USER ACCESS TOKEN
      // =======================================================

      const tokenUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token` +
        `?client_id=${encodeURIComponent(
          env.META_APP_ID
        )}` +
        `&client_secret=${encodeURIComponent(
          env.META_APP_SECRET
        )}` +
        `&redirect_uri=${encodeURIComponent(
          redirectUri
        )}` +
        `&code=${encodeURIComponent(
          code
        )}`;


      const tokenResponse =
        await fetch(
          tokenUrl
        );


      const tokenData =
        await tokenResponse.json();


      if (
        !tokenResponse.ok ||
        tokenData.error
      ) {

        return new Response(
          `
          <pre>${escapeHtml(
            JSON.stringify(
              tokenData,
              null,
              2
            )
          )}</pre>
          `,
          {
            status: 400,
            headers: {
              "content-type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }


      const userAccessToken =
        tokenData.access_token;


      // =======================================================
      // GET FACEBOOK USER ID
      // =======================================================

      const meUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me` +
        `?fields=id` +
        `&access_token=${encodeURIComponent(
          userAccessToken
        )}`;


      const meResponse =
        await fetch(
          meUrl
        );


      const meData =
        await meResponse.json();


      if (
        !meResponse.ok ||
        meData.error ||
        !meData.id
      ) {

        return new Response(
          `
          <pre>${escapeHtml(
            JSON.stringify(
              meData,
              null,
              2
            )
          )}</pre>
          `,
          {
            status: 400,
            headers: {
              "content-type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }


      const facebookUserId =
        meData.id;


      // =======================================================
      // SAVE / UPDATE FACEBOOK ACCOUNT
      // =======================================================

      await env.DB.prepare(`
        INSERT INTO facebook_accounts
        (
          facebook_user_id,
          access_token
        )
        VALUES (?, ?)

        ON CONFLICT(facebook_user_id)
        DO UPDATE SET
          access_token =
            excluded.access_token
      `)
        .bind(
          facebookUserId,
          userAccessToken
        )
        .run();


      // =======================================================
      // GET ACCOUNT ID
      // =======================================================

      const accountResult =
        await env.DB.prepare(`
          SELECT
            id
          FROM facebook_accounts
          WHERE facebook_user_id = ?
        `)
        .bind(
          facebookUserId
        )
        .first();


      if (
        !accountResult ||
        !accountResult.id
      ) {

        return new Response(
          "Facebook account could not be saved.",
          {
            status: 500
          }
        );

      }


      const accountId =
        accountResult.id;


      // =======================================================
      // GET FACEBOOK PAGES
      // =======================================================

      let pagesUrl =
        `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
        `?fields=id,name,access_token` +
        `&limit=100` +
        `&access_token=${encodeURIComponent(
          userAccessToken
        )}`;


      let savedPages = 0;
      let totalPagesFound = 0;


      // =======================================================
      // PAGINATION LOOP
      // =======================================================

      while (pagesUrl) {

        const pagesResponse =
          await fetch(
            pagesUrl
          );


        const pagesData =
          await pagesResponse.json();


        if (
          !pagesResponse.ok ||
          pagesData.error
        ) {

          return new Response(
            `
            <pre>${escapeHtml(
              JSON.stringify(
                pagesData,
                null,
                2
              )
            )}</pre>
            `,
            {
              status: 400,
              headers: {
                "content-type":
                  "text/html;charset=UTF-8"
              }
            }
          );

        }


        const currentPages =
          pagesData.data || [];


        totalPagesFound +=
          currentPages.length;


        // =====================================================
        // SAVE / UPDATE PAGES
        // =====================================================

        for (
          const page
          of currentPages
        ) {

          if (
            !page.id ||
            !page.name ||
            !page.access_token
          ) {

            continue;

          }


          const existingPage =
            await env.DB.prepare(`
              SELECT
                id
              FROM facebook_pages
              WHERE account_id = ?
                AND page_id = ?
            `)
            .bind(
              accountId,
              page.id
            )
            .first();


          // ---------------------------------------------------
          // UPDATE EXISTING PAGE
          // ---------------------------------------------------

          if (existingPage) {

            await env.DB.prepare(`
              UPDATE facebook_pages
              SET
                page_name = ?,
                page_access_token = ?
              WHERE id = ?
            `)
              .bind(
                page.name,
                page.access_token,
                existingPage.id
              )
              .run();

          }


          // ---------------------------------------------------
          // INSERT NEW PAGE
          // ---------------------------------------------------

          else {

            await env.DB.prepare(`
              INSERT INTO facebook_pages
              (
                account_id,
                page_id,
                page_name,
                page_access_token
              )
              VALUES (?, ?, ?, ?)
            `)
              .bind(
                accountId,
                page.id,
                page.name,
                page.access_token
              )
              .run();

          }


          savedPages++;

        }


        // -----------------------------------------------------
        // NEXT PAGE
        // -----------------------------------------------------

        pagesUrl =
          pagesData.paging?.next || null;

      }


      // =======================================================
      // SUCCESS PAGE
      // =======================================================

      return new Response(
        `
        <!DOCTYPE html>

        <html>

        <head>

          <title>
            Facebook Connected
          </title>

          <meta
            name="viewport"
            content="width=device-width, initial-scale=1"
          >

        </head>


        <body
          style="font-family:Arial;padding:30px"
        >

          <h2>
            Facebook Connected ✅
          </h2>


          <p>

            Facebook Account Connected:

            <strong>
              ${escapeHtml(
                facebookUserId
              )}
            </strong>

          </p>


          <p>

            Pages found:

            <strong>
              ${totalPagesFound}
            </strong>

          </p>


          <p>

            Pages saved / updated:

            <strong>
              ${savedPages}
            </strong>

          </p>


          <p>
            Pages have been saved to the database.
          </p>


          <p>

            <a href="/">
              ← Back to Dashboard
            </a>

          </p>


        </body>

        </html>
        `,
        {
          headers: {
            "content-type":
              "text/html;charset=UTF-8"
          }
        }
      );

    }


    // =========================================================
    // SYNC FACEBOOK PAGES
    // =========================================================

    if (
      url.pathname === "/sync-pages" &&
      request.method === "POST"
    ) {

      try {

        const formData =
          await request.formData();


        const accountId =
          String(
            formData.get(
              "account_id"
            ) || ""
          ).trim();


        // -----------------------------------------------------
        // VALIDATE ACCOUNT ID
        // -----------------------------------------------------

        if (!accountId) {

          return htmlResult(
            "Invalid Account",
            "Facebook account ID is missing.",
            true
          );

        }


        // -----------------------------------------------------
        // GET SAVED ACCOUNT TOKEN
        // -----------------------------------------------------

        const account =
          await env.DB.prepare(`
            SELECT
              id,
              facebook_user_id,
              access_token
            FROM facebook_accounts
            WHERE id = ?
          `)
          .bind(
            accountId
          )
          .first();


        if (!account) {

          return htmlResult(
            "Account Not Found",
            "The Facebook account was not found.",
            true
          );

        }


        if (
          !account.access_token
        ) {

          return htmlResult(
            "Access Token Missing",
            "This Facebook account does not have a saved access token. Please reconnect the Facebook account.",
            true
          );

        }


        // =====================================================
        // GET PAGES FROM FACEBOOK
        // =====================================================

        let pagesUrl =
          `https://graph.facebook.com/${env.META_GRAPH_VERSION}/me/accounts` +
          `?fields=id,name,access_token` +
          `&limit=100` +
          `&access_token=${encodeURIComponent(
            account.access_token
          )}`;


        let totalPagesFound = 0;
        let savedPages = 0;
        let newPages = 0;
        let updatedPages = 0;


        // =====================================================
        // PAGINATION
        // =====================================================

        while (pagesUrl) {

          const pagesResponse =
            await fetch(
              pagesUrl
            );


          const pagesData =
            await pagesResponse.json();


          // ---------------------------------------------------
          // FACEBOOK API ERROR
          // ---------------------------------------------------

          if (
            !pagesResponse.ok ||
            pagesData.error
          ) {

            const apiMessage =
              pagesData?.error?.message ||
              "Facebook API returned an error.";


            return htmlResult(
              "Sync Failed",
              apiMessage +
                " Please reconnect this Facebook account if the access token has expired.",
              true
            );

          }


          const currentPages =
            pagesData.data || [];


          totalPagesFound +=
            currentPages.length;


          // ===================================================
          // SAVE / UPDATE EACH PAGE
          // ===================================================

          for (
            const page
            of currentPages
          ) {

            if (
              !page.id ||
              !page.name ||
              !page.access_token
            ) {

              continue;

            }


            const existingPage =
              await env.DB.prepare(`
                SELECT
                  id
                FROM facebook_pages
                WHERE account_id = ?
                  AND page_id = ?
              `)
              .bind(
                account.id,
                page.id
              )
              .first();


            // -------------------------------------------------
            // UPDATE EXISTING PAGE
            // -------------------------------------------------

            if (existingPage) {

              await env.DB.prepare(`
                UPDATE facebook_pages
                SET
                  page_name = ?,
                  page_access_token = ?
                WHERE id = ?
              `)
                .bind(
                  page.name,
                  page.access_token,
                  existingPage.id
                )
                .run();


              updatedPages++;

            }


            // -------------------------------------------------
            // INSERT NEW PAGE
            // -------------------------------------------------

            else {

              await env.DB.prepare(`
                INSERT INTO facebook_pages
                (
                  account_id,
                  page_id,
                  page_name,
                  page_access_token
                )
                VALUES (?, ?, ?, ?)
              `)
                .bind(
                  account.id,
                  page.id,
                  page.name,
                  page.access_token
                )
                .run();


              newPages++;

            }


            savedPages++;

          }


          // ---------------------------------------------------
          // NEXT PAGE FROM FACEBOOK
          // ---------------------------------------------------

          pagesUrl =
            pagesData.paging?.next || null;

        }


        // =====================================================
        // SUCCESS
        // =====================================================

        return new Response(
          `
          <!DOCTYPE html>

          <html>

          <head>

            <title>
              Pages Synced
            </title>

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            >

          </head>


          <body
            style="
              font-family:Arial;
              padding:30px;
              background:#f5f7fb;
            "
          >

            <div
              style="
                background:white;
                padding:25px;
                border-radius:12px;
                max-width:700px;
                margin:auto;
              "
            >

              <h2>
                Pages Synced Successfully ✅
              </h2>


              <p>

                Facebook Account:

                <strong>
                  ${escapeHtml(
                    account.facebook_user_id
                  )}
                </strong>

              </p>


              <hr>


              <p>

                📄 Pages found on Facebook:

                <strong>
                  ${totalPagesFound}
                </strong>

              </p>


              <p>

                🆕 New Pages added:

                <strong>
                  ${newPages}
                </strong>

              </p>


              <p>

                🔄 Existing Pages updated:

                <strong>
                  ${updatedPages}
                </strong>

              </p>


              <p>

                💾 Total Pages saved / updated:

                <strong>
                  ${savedPages}
                </strong>

              </p>


              <p
                style="
                  color:#166534;
                  background:#f0fdf4;
                  padding:12px;
                  border-radius:8px;
                "
              >

                New Facebook Pages have been
                synchronized with your publisher.

              </p>


              <p>

                <a
                  href="/"
                  style="
                    display:inline-block;
                    background:#1877f2;
                    color:white;
                    padding:12px 18px;
                    border-radius:8px;
                    text-decoration:none;
                  "
                >
                  ← Back to Dashboard
                </a>

              </p>

            </div>

          </body>

          </html>
          `,
          {
            headers: {
              "content-type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }


      catch (
        error
      ) {

        return htmlResult(
          "Sync Pages Error",
          error.message ||
            "Unable to synchronize Facebook Pages.",
          true
        );

      }

    }


    // =========================================================
    // REMOVE FACEBOOK ACCOUNT
    // =========================================================

    if (
      url.pathname === "/remove-account" &&
      request.method === "POST"
    ) {

      try {

        const formData =
          await request.formData();


        const accountId =
          String(
            formData.get(
              "account_id"
            ) || ""
          ).trim();


        if (!accountId) {

          return htmlResult(
            "Invalid Account",
            "Facebook account ID is missing.",
            true
          );

        }


        // -----------------------------------------------------
        // FIND ACCOUNT
        // -----------------------------------------------------

        const account =
          await env.DB.prepare(`
            SELECT
              id,
              facebook_user_id
            FROM facebook_accounts
            WHERE id = ?
          `)
          .bind(
            accountId
          )
          .first();


        if (!account) {

          return htmlResult(
            "Account Not Found",
            "The Facebook account was not found.",
            true
          );

        }


        // -----------------------------------------------------
        // DELETE ACCOUNT PAGES
        // -----------------------------------------------------

        await env.DB.prepare(`
          DELETE FROM facebook_pages
          WHERE account_id = ?
        `)
        .bind(
          accountId
        )
        .run();


        // -----------------------------------------------------
        // DELETE FACEBOOK ACCOUNT
        // -----------------------------------------------------

        await env.DB.prepare(`
          DELETE FROM facebook_accounts
          WHERE id = ?
        `)
        .bind(
          accountId
        )
        .run();


        // -----------------------------------------------------
        // SUCCESS
        // -----------------------------------------------------

        return new Response(
          `
          <!DOCTYPE html>

          <html>

          <head>

            <title>
              Account Removed
            </title>

            <meta
              name="viewport"
              content="width=device-width, initial-scale=1"
            >

          </head>


          <body
            style="font-family:Arial;padding:30px"
          >

            <h2>
              Facebook Account Removed ✅
            </h2>


            <p>

              Facebook Account:

              <strong>
                ${escapeHtml(
                  account.facebook_user_id
                )}
              </strong>

              aur is ke tamam Pages
              publisher database se remove ho gaye hain.

            </p>


            <p>

              <a href="/">
                ← Back to Dashboard
              </a>

            </p>

          </body>

          </html>
          `,
          {
            headers: {
              "content-type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }


      catch (
        error
      ) {

        return htmlResult(
          "Remove Account Error",
          error.message ||
            "Unable to remove Facebook account.",
          true
        );

      }

    }


    // =========================================================
    // PUBLISH
    // =========================================================

    if (
      url.pathname === "/publish" &&
      request.method === "POST"
    ) {

      try {

        const formData =
          await request.formData();


        // -----------------------------------------------------
        // MESSAGE
        // -----------------------------------------------------

        const message =
          String(
            formData.get(
              "message"
            ) || ""
          ).trim();


        // -----------------------------------------------------
        // SELECTED PAGE IDS
        // -----------------------------------------------------

        const selectedPageIds =
          formData
            .getAll(
              "page_ids"
            )
            .map(
              id => String(id)
            )
            .filter(
              Boolean
            );


        // -----------------------------------------------------
        // IMAGE
        // -----------------------------------------------------

        const image =
          formData.get(
            "image"
          );


        // -----------------------------------------------------
        // VIDEO
        // -----------------------------------------------------

        const video =
          formData.get(
            "video"
          );


        const hasImage =
          image instanceof File &&
          image.size > 0;


        const hasVideo =
          video instanceof File &&
          video.size > 0;


        // =====================================================
        // VALIDATION
        // =====================================================

        if (
          !selectedPageIds.length
        ) {

          return htmlResult(
            "No Pages Selected",
            "Please select at least one Facebook Page.",
            true
          );

        }


        if (
          !message &&
          !hasImage &&
          !hasVideo
        ) {

          return htmlResult(
            "Post Empty",
            "Please enter post text or select an image or video.",
            true
          );

        }


        if (
          hasImage &&
          hasVideo
        ) {

          return htmlResult(
            "Choose One Media",
            "Please select either an image or a video, not both.",
            true
          );

        }


        // =====================================================
        // GET SELECTED PAGES
        // =====================================================

        const placeholders =
          selectedPageIds
            .map(
              () => "?"
            )
            .join(",");


        const pagesResult =
          await env.DB.prepare(`
            SELECT
              page_id,
              page_name,
              page_access_token
            FROM facebook_pages
            WHERE page_id IN (
              ${placeholders}
            )
          `)
          .bind(
            ...selectedPageIds
          )
          .all();


        const pages =
          pagesResult.results || [];


        const results = [];


        // =====================================================
        // PUBLISH TO EACH PAGE
        // =====================================================

        for (
          const page
          of pages
        ) {

          try {

            let graphResponse;
            let graphData;


            // =================================================
            // VIDEO
            // =================================================

            if (
              hasVideo
            ) {

              const uploadData =
                new FormData();


              uploadData.append(
                "source",
                video,
                video.name ||
                  "video.mp4"
              );


              if (
                message
              ) {

                uploadData.append(
                  "description",
                  message
                );

              }


              uploadData.append(
                "access_token",
                page.page_access_token
              );


              graphResponse =
                await fetch(
                  `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/videos`,
                  {
                    method: "POST",
                    body: uploadData
                  }
                );


              graphData =
                await graphResponse.json();

            }


            // =================================================
            // IMAGE
            // =================================================

            else if (
              hasImage
            ) {

              const uploadData =
                new FormData();


              uploadData.append(
                "source",
                image,
                image.name ||
                  "image.jpg"
              );


              if (
                message
              ) {

                uploadData.append(
                  "message",
                  message
                );

              }


              uploadData.append(
                "published",
                "true"
              );


              uploadData.append(
                "access_token",
                page.page_access_token
              );


              graphResponse =
                await fetch(
                  `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/photos`,
                  {
                    method: "POST",
                    body: uploadData
                  }
                );


              graphData =
                await graphResponse.json();

            }


            // =================================================
            // TEXT
            // =================================================

            else {

              const postData =
                new URLSearchParams();


              postData.set(
                "message",
                message
              );


              postData.set(
                "access_token",
                page.page_access_token
              );


              graphResponse =
                await fetch(
                  `https://graph.facebook.com/${env.META_GRAPH_VERSION}/${page.page_id}/feed`,
                  {
                    method: "POST",

                    headers: {
                      "content-type":
                        "application/x-www-form-urlencoded"
                    },

                    body:
                      postData
                  }
                );


              graphData =
                await graphResponse.json();

            }


            // =================================================
            // RESULT
            // =================================================

            if (
              !graphResponse.ok ||
              graphData.error
            ) {

              results.push({
                page_name:
                  page.page_name,

                success:
                  false,

                message:
                  graphData?.error?.message ||
                  "Facebook publishing failed."
              });

            }


            else {

              results.push({
                page_name:
                  page.page_name,

                success:
                  true,

                message:
                  "Published successfully."
              });

            }

          }


          catch (
            error
          ) {

            results.push({
              page_name:
                page.page_name,

              success:
                false,

              message:
                error.message ||
                "Unknown error."
            });

          }

        }


        // =====================================================
        // RESULTS
        // =====================================================

        return publishResultsPage(
          results
        );

      }


      catch (
        error
      ) {

        return htmlResult(
          "Publishing Error",
          error.message ||
            "Unknown publishing error.",
          true
        );

      }

    }


    // =========================================================
    // NOT FOUND
    // =========================================================

    return new Response(
      "Not found",
      {
        status: 404
      }
    );

  }
};


// =============================================================
// PUBLISH RESULTS PAGE
// =============================================================

function publishResultsPage(
  results
) {

  const successCount =
    results.filter(
      result =>
        result.success
    ).length;


  const failedCount =
    results.filter(
      result =>
        !result.success
    ).length;


  const rows =
    results
      .map(
        result => `
          <tr>

            <td>
              ${
                result.success
                  ? "✅"
                  : "❌"
              }
            </td>


            <td>
              ${escapeHtml(
                result.page_name
              )}
            </td>


            <td>
              ${escapeHtml(
                result.message
              )}
            </td>

          </tr>
        `
      )
      .join("");


  return new Response(
    `
    <!DOCTYPE html>

    <html>

    <head>

      <title>
        Publish Results
      </title>


      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >


      <style>

        body {
          font-family: Arial;
          padding: 30px;
          background: #f5f7fb;
        }


        .box {
          background: white;
          padding: 25px;
          border-radius: 12px;
          max-width: 1000px;
          margin: auto;
        }


        table {
          width: 100%;
          border-collapse: collapse;
          margin-top: 20px;
        }


        th,
        td {
          padding: 10px;
          border-bottom: 1px solid #ddd;
          text-align: left;
        }


        th {
          background: #f0f2f5;
        }


        a {
          display: inline-block;
          margin-top: 20px;
          background: #1877f2;
          color: white;
          padding: 12px 18px;
          border-radius: 8px;
          text-decoration: none;
        }


        @media (max-width: 700px) {

          body {
            padding: 10px;
          }


          .box {
            padding: 15px;
          }


          table {
            font-size: 13px;
          }


          th,
          td {
            padding: 7px;
          }

        }

      </style>

    </head>


    <body>

      <div class="box">

        <h2>
          Publish Results
        </h2>


        <p>

          ✅ Successful:

          <strong>
            ${successCount}
          </strong>

        </p>


        <p>

          ❌ Failed:

          <strong>
            ${failedCount}
          </strong>

        </p>


        <table>

          <thead>

            <tr>

              <th>
                Status
              </th>

              <th>
                Page
              </th>

              <th>
                Result
              </th>

            </tr>

          </thead>


          <tbody>

            ${rows}

          </tbody>

        </table>


        <a href="/">
          ← Back to Dashboard
        </a>

      </div>

    </body>

    </html>
    `,
    {
      headers: {
        "content-type":
          "text/html;charset=UTF-8"
      }
    }
  );

}


// =============================================================
// GENERIC RESULT PAGE
// =============================================================

function htmlResult(
  title,
  message,
  isError = false
) {

  return new Response(
    `
    <!DOCTYPE html>

    <html>

    <head>

      <title>
        ${escapeHtml(title)}
      </title>


      <meta
        name="viewport"
        content="width=device-width, initial-scale=1"
      >

    </head>


    <body
      style="font-family:Arial;padding:30px"
    >

      <h2>

        ${
          isError
            ? "❌"
            : "✅"
        }

        ${escapeHtml(
          title
        )}

      </h2>


      <p>
        ${escapeHtml(
          message
        )}
      </p>


      <p>

        <a href="/">
          ← Back to Dashboard
        </a>

      </p>


    </body>

    </html>
    `,
    {
      status:
        isError
          ? 400
          : 200,

      headers: {
        "content-type":
          "text/html;charset=UTF-8"
      }
    }
  );

}


// =============================================================
// HTML ESCAPE
// =============================================================

function escapeHtml(
  value
) {

  return String(
    value
  )
    .replaceAll(
      "&",
      "&amp;"
    )
    .replaceAll(
      "<",
      "&lt;"
    )
    .replaceAll(
      ">",
      "&gt;"
    )
    .replaceAll(
      '"',
      "&quot;"
    )
    .replaceAll(
      "'",
      "&#039;"
    );

}
