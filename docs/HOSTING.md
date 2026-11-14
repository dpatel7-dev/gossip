# Putting gossip online

There are two things you can put online. You only need the first.

| | What it gives you | Cost |
| --- | --- | --- |
| **The gossip website** (PythonAnywhere) | The install page **and** the place that passes messages along. Friends install from it and never type an address. | Free plan is enough for a group of friends |
| **A copy of the install page** (Netlify) | Just the page - a second, fast address for it. It can't pass messages. | Free |

If you already run a relay with `gossip serve`, that keeps working too. People
can use either one.

---

## 1. The gossip website on PythonAnywhere

You do this once. It takes about five minutes and you never touch a server.

1. **Make an account** at <https://www.pythonanywhere.com> (the free "Beginner" one).
   Your site will be `https://YOURNAME.pythonanywhere.com`, so pick a username you like.

2. **Get the code.** Click **Consoles**, then **Bash**. In the black window that opens, paste this and press Enter:

   ```sh
   git clone https://github.com/dpatel7-dev/gossip.git
   ```

3. **Create the web app.** Click **Web**, then **Add a new web app**.
   - Press **Next** on the first screen.
   - Choose **Manual configuration** (not Flask).
   - Choose the newest **Python 3** in the list, then **Next**.

4. **Tell it to run gossip.** On the Web page, find **WSGI configuration file** and click the link next to it.
   Delete everything in that file and paste these four lines instead:

   ```python
   import os
   import sys
   sys.path.insert(0, os.path.expanduser('~/gossip/hub'))
   from gossip_hub import application
   ```

   Click **Save**.

5. **Start it.** Go back to the **Web** page and press the green **Reload** button.

6. **Look at it.** Open `https://YOURNAME.pythonanywhere.com`. You should see the gossip page with a penguin on it.
   The install line on that page already points at your site.

That's it. Send friends the link. They paste the install line, type `gossip`, pick a username, and they're chatting.

### Things to know

- **Click the "Run until..." button about once a month.** Free PythonAnywhere sites switch off unless you log in and press the button on the **Web** page. They email you a reminder. Nothing is lost if it lapses - press the button and it's back.
- **It's sized for friends, not crowds.** The free plan runs one request at a time. Dozens of people is fine; hundreds chatting at once is not.
- **The website can't read anyone's messages.** It stores usernames with their public keys, and sealed messages only until they're delivered. Its data lives in `~/gossip-data` on PythonAnywhere.
- **To get a newer gossip onto the site:** open a Bash console, run `cd ~/gossip && git pull`, then press **Reload** on the Web page.
- **To close sign-ups** once your friends are in: create the file `~/gossip-data/config.json` containing `{"signups": false}` and press Reload. You can also set `"name"` and `"motd"` (a welcome line) there.

### Make calls work on strict networks (optional, recommended)

Calls go straight between two computers. Some school, office and phone networks
block that, and then a call can't connect. gossip comes with its own **call
relay** (a "TURN server") that passes the call along when the direct path is
blocked. The call stays end-to-end encrypted; the relay only sees scrambled
packets. It also lets people hide their IP address from whoever they call
(`gossip config call.hideip on`).

You don't need this for calls to work - most calls connect directly. It only
helps on networks that block direct calls.

PythonAnywhere can't run a call relay itself (calls need ports that websites
don't get), so there are two ways to get one:

- **Option A - a free relay service.** No server, nothing running on your computer. Takes 5 minutes.
- **Option B - run gossip's own relay** on a machine that's always on (like a cloud VM).

#### Option A: a free relay service (no server needed)

[ExpressTURN](https://www.expressturn.com/) gives you a call relay for free
(1 TB a month - thousands of hours of calls) with no credit card.

1. Go to <https://www.expressturn.com/signup> and make an account.
2. On your ExpressTURN dashboard, find three things and copy them somewhere:
   the **server address** (usually `relay1.expressturn.com`), your **username**
   (`turn_username`) and your **password** (`turn_password`).
3. On PythonAnywhere, open the **Files** tab, go to `gossip-data`, and open (or
   create) `config.json`. Make it look like this, putting in your own username
   and password (4 places) - and your own server address if it isn't `relay1`:

   ```json
   {
     "turn": [
       { "urls": "turn:relay1.expressturn.com:3478", "username": "YOUR_USERNAME", "credential": "YOUR_PASSWORD" },
       { "urls": "turns:relay1.expressturn.com:443?transport=tcp", "username": "YOUR_USERNAME", "credential": "YOUR_PASSWORD" }
     ]
   }
   ```

   If the file already has something in it (like `"signups": false`), keep
   that line and put a comma after it, like this:

   ```json
   {
     "signups": false,
     "turn": [ ... ]
   }
   ```

4. Click **Save**, then press **Reload** on the **Web** page.

That's it - everyone signed in to your site gets the relay automatically. To
check it: start a call, then look at the call window; on a network that needs
the relay it says **"through a relay"** next to the signal bars.

Good to know: everyone signed in to your site can see this username and
password (their gossip needs it to use the relay). That's normal for free
relays. If someone ever abuses it, change the password on ExpressTURN and
update `config.json`.

If you'd rather not even touch the website, each person can add it to just
their own gossip instead:
`gossip config call.turn "turn:relay1.expressturn.com:3478 YOUR_USERNAME YOUR_PASSWORD"`.

#### Option B: run gossip's own relay

It needs a machine that's always on and reachable from the internet - a small
cloud VM is perfect (the smallest free one is plenty).

1. **On the VM**, install gossip (same line as everyone else) and start the call relay as a service:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/dpatel7-dev/gossip/main/install.sh | sh
   sh ~/.gossip/app/deploy/setup-turn.sh
   ```

   It prints two lines that start with `"turn_server"` and `"turn_secret"`. Copy them.

2. **Open the ports.** From your own computer (or Google Cloud Shell):

   ```sh
   gcloud compute firewall-rules create gossip-turn --allow tcp:3478,udp:3478,udp:49152-65535
   ```

3. **Tell your website about it.** On PythonAnywhere, open the **Files** tab, go to `gossip-data`, and open (or create) `config.json`. Paste the two lines between curly brackets, so the file looks like this (with your own numbers):

   ```json
   {
     "turn_server": "34.120.5.6:3478",
     "turn_secret": "9f2c...a71b"
   }
   ```

   If the file already has something in it, add a comma after the last line before pasting.

4. Click **Save**, then press **Reload** on the **Web** page.

That's it. Everyone using your site gets a call login that works for a day,
handed out automatically - nobody types a password. (On your own relay instead:
`gossip serve --turn-server 34.120.5.6:3478 --turn-secret 9f2c...a71b`.)

If you ever need the two lines again, run `journalctl -u gossip-turn -n 12 -o cat` on the VM.

### Make it the default for everyone (optional)

People who install from your page are already connected to it. If you'd also
like the plain GitHub install line (and the Netlify copy) to use it, put your
site's address in `gossip.config.json` at the top of the repo:

```json
{
  "repo": "dpatel7-dev/gossip",
  "branch": "main",
  "hub": "https://YOURNAME.pythonanywhere.com"
}
```

On GitHub: open the file, click the pencil, change the line, click **Commit changes**.

---

## 2. A copy of the install page on Netlify

1. Make an account at <https://www.netlify.com> and choose **Sign up with GitHub**.
2. Click **Add new site**, then **Import an existing project**, then **GitHub**.
3. Pick the **gossip** repository.
4. Don't change any settings (the `netlify.toml` file in the repo already says what to publish). Click **Deploy**.
5. After a minute you get an address like `https://something.netlify.app`. You can rename it under **Site configuration**.

Every time the repo changes on GitHub, Netlify updates the page by itself.

The Netlify page shows the GitHub install line. For people who install from
there to be connected automatically, do the "Make it the default" step above.

---

## Running the website somewhere else

It's one Python file with no dependencies:

```sh
python3 hub/gossip_hub.py --port 8080 --data ./gossip-data
```

Any host that can run a WSGI app can run it: point it at `application` in
`hub/gossip_hub.py`. Settings can also come from environment variables:
`GOSSIP_DATA`, `GOSSIP_NAME`, `GOSSIP_MOTD`, `GOSSIP_SIGNUPS=off`, `GOSSIP_PUBLIC_URL`.

## Changing the page

Edit `site/index.src.html`, then run `node tools/build-site.js`. That writes
`site/index.html` with the penguin's animation frames copied from the app, so
the website's Pebble is always the app's Pebble.
