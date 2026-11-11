# Install apps

A Vetro Shard: install `.wgt` and `.tpk` packages on the TV from the dashboard (**Vetro Shards → Install apps**).

- **Upload and install** a package of up to 400 MB, as it is or signed first with your developer certificate.
- After a web app (`.wgt`) is installed it gets a row in Samsung's app registry and a tile on the Samsung Home
  row, like a store app, and the Vetro launcher is asked to read its list again.
- **Installed apps**: launch, add to Home, uninstall (the registry row and the Home tile go with it). Firmware
  packages are listed on request but never uninstalled from here.

It talks to nothing outside the TV.

## Your developer certificate

Signing needs the author and distributor `.p12` files of a Tizen certificate profile made for your TV, and
their passwords. You give them once, under **Developer certificate**:

- the files are converted to PEM on the TV with its own `openssl`, and the result is kept in this Shard's
  `config.json` on the TV (mode 600). That file holds your **private keys**: anyone with root on the TV can read
  it, as they can read everything else there;
- the passwords are used for the conversion and not kept;
- nothing is sent back to the page except the certificate's subject and expiry date;
- **Remove from the TV** deletes them. Removing the Shard deletes them too.

No certificate ships with the Shard.

## The `exec` permission: commands it runs

All as root, through `ctx.execute`, and only when you press something on the page (opening the page lists the
installed apps).

| When | Command |
| --- | --- |
| the page opens, Refresh | `pkgcmd -l`, `app_launcher -l` |
| Save certificate | `openssl pkcs12 -in <file> -nokeys` and `-nocerts -nodes` in a private `mktemp` folder under `/tmp`, removed when the command ends; the password reaches openssl on stdin, never on a command line; `openssl x509 -noout -subject -enddate` |
| Upload and install | `pkgcmd -i -t wgt|tpk -p /tmp/install-apps-shard/<file>`: only a file this Shard uploaded, with a name of letters, digits, dot, dash and underscore |
| after a `.wgt` install, Add to Home | `registry.js`: reads `/opt/dbspace/.pkgmgr_parser.db`, adds one row to `/opt/dbspace/.webappservice.db` (a copy of the database is kept first as `/opt/usr/home/owner/share/vetro-webappservice.db.bak`), copies the app's icon, restarts `org.tizen.webappservice`. `home-order.js`: closes Samsung Home if it runs and adds the tile to its row file, as one transaction with a rollback |
| Launch | `app_launcher -s <app id>` |
| Uninstall | `pkgcmd -u -n <package id>`, then the registry row and the Home tile are removed the same way |

Package and app ids must match `[A-Za-z0-9_.-]` before they reach a command.

One request goes to Vetro itself: `POST http://127.0.0.1:8099/dock {"action":"refresh"}`, so the launcher shows
a new or removed app at once. If that fails nothing else is affected.

## Files

- `index.js`: routes, upload, certificate, install and uninstall.
- `sign.js`: the package signer (author-signature.xml and signature1.xml, SHA-512 digests, RSA-SHA512), using
  only Node's own modules. Its output was compared byte for byte with the `tizen` npm package's signer on a
  test key.
- `registry.js`, `home-order.js`: copies of `app/service/webapp-registry.js` and `app/service/home-order.js`
  from the same repository. A Shard cannot use Vetro's modules, so it carries them.
- `page.html`: the page.

## Limits

- **Tested on one TV only: a QN85A (Tizen 6).** The registry and Home row steps depend on Samsung's files as
  they are on that firmware; on another model an install may succeed and the tile not appear.
- Needs the root helper, `openssl`, `sqlite3` and `pkgcmd` on the TV.
- Zip64 packages and encrypted zips are not signed. A `.tpk` is signed the same way as a `.wgt`; that was
  not tried on a TV.
- The registry step applies to web apps only.
