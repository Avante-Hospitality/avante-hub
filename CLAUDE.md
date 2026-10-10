# Avante Travel hub — notes for anyone changing this code

## Rule: keep the how-to guides up to date (Jean, 2026-10-10)

The hub has step-by-step "toddler version" guides for every screen and every button.
**Every change that changes what a user sees or does must update the matching guide
in the same commit.** No exceptions: a new button, a renamed label, a new rule, a
removed screen, a new setting.

| Guide | Covers | Update it when you change |
|---|---|---|
| `how-to.html` | Affiliate hub, front store, login, password, application, onboarding form | `hub.html`, `landing.html`, `login.html`, `reset-password.html`, `affiliate-application.html`, `property-form.html`, `promo.html`, link building (`booking-links.js`) |
| `how-to-property.html` | Property Affiliate tab | `property-affiliate.js` / `.css`, `netlify/edge-functions/lib/pa-core.js`, `pa-api.js`, `approve-cancel.html` |
| `how-to-hook-builder.html` | The hook builder (lives in the separate `avante-hooks` repo) | anything user-facing in `avante-hooks/public/index.html` |
| `how-to-admin.html` | Admin | `admin.html`, `admin-login.html`, `explore-tree.html`, `tree-lookup.html`, `property-agreement.html`, admin edge functions |

When you update a guide:
1. Change the steps in the right `<section id="…">`. Use the **exact on-screen labels**.
2. Keep it toddler-simple: one action per step, short sentences, numbered `<ol class="steps">`.
   Buttons as `<span class="btn">Label</span>` (`btn g` = outlined, `btn t` = teal),
   fields as `<span class="field">Label</span>`, tabs as `<span class="tab">Label</span>`.
   Extra info goes in `<div class="tip">`, risks in `<div class="warn">`.
3. Add a dated line at the top of **What's new** in that guide, and change **Last updated**.
4. New panel or screen? Add a `<section>` whose id is the panel id without `panel-`
   (e.g. `panel-accom` → `#accom`). `how-to-links.js` links each panel's **❓ How to**
   button to that id. In Property Affiliate the link map is in `render()` (`howTo`).
5. Removed something? Remove it from the guide too.

Shared files: `how-to.css` (look), `how-to.js` (contents list + search), `how-to-links.js`
(the ❓ How to buttons on hub and admin panels).

## Other standing rules
- Ask Jean before uploading to GitHub or deploying (push / merge to main deploys via Netlify).
- Commit as Jean (user.email jeanl1967@gmail.com).
