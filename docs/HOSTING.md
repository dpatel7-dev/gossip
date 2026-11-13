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
