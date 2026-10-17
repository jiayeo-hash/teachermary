# Teacher Mary mockup

A clickable mockup of a website where every class gets its own "room":
the teacher shares a link for each lesson, students pick their name, find that
lesson's reading and hand in homework there, and the teacher watches or reads it in the browser.

It is a plain static site. No build step, no dependencies, nothing is saved or
uploaded yet (names and files are made up).

## What is in here

```
public/
  index.html      start page with links to the three views
  dashboard.html  teacher: your classes
  room.html       teacher: review homework inside a class room
  student.html    student: the room (phone, iPad and computer)
  dc-lite.js      small helper that draws the pages (no build needed)
  robots.txt      asks search engines not to list the site
```

All pages also carry a `noindex` tag, so search engines should skip them while
this is only a mockup. Remove `robots.txt` and the `noindex` lines when you want
the site to be findable.

To change text or colours, edit the HTML files in `public/`. Each page keeps its
words in the markup and its sample data (students, weeks, files) in the
`<script type="text/x-dc">` block near the bottom.

## 1. Put it on GitHub

Create an empty repository on github.com (private is fine), then in this folder:

```
git init
git add .
git commit -m "Teacher Mary mockup"
git branch -M main
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

(Or use "Add file > Upload files" on the repository page and drag everything in.)

## 2. Connect it to Cloudflare

1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git.
2. Pick the repository.
3. Build settings:
   - Framework preset: None
   - Build command: `exit 0`
   - Build output directory: `public`
4. Save and Deploy. You get an address like `your-project.pages.dev`.
   Every later `git push` redeploys automatically.

## 3. Use your own domain

Project > Custom domains > Set up a domain, and enter the domain.

- If the domain's nameservers are on Cloudflare (for example it was bought
  through Cloudflare), the bare domain works and the DNS record is created for you.
- If the domain is registered elsewhere and stays there, use a subdomain such as
  `www.yourdomain.com` and add a CNAME record at your registrar pointing to
  `your-project.pages.dev`. For the bare domain you need to move its nameservers
  to Cloudflare.
- Add the domain in the Cloudflare dashboard first. A CNAME added on its own
  will show a 522 error.

## Later

This mockup only shows the idea. The real version will need somewhere to keep
uploaded files and class data, and a way to protect each room's link.
