---
"@svdr/cli": patch
---

With live reload, a page that throws while it renders now shows the error in the overlay instead of a plain-text 500: the page is served empty, or with whatever had already been streamed, and keeps reloading on changes.
