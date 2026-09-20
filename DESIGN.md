---
version: alpha
name: Infinite Atelier
description: A neutral creative workbench with quiet, explicit account and integration controls.
colors:
  primaryLight: "#171717"
  primaryDark: "#fafafa"
  elevatedLight: "#ffffff"
  elevatedDark: "#1c1917"
rounded:
  DEFAULT: "0.625rem"
spacing:
  authPanelPadding: "1rem"
  authCodePadding: "0.75rem"
  authPanelGap: "1rem"
omitted:
  - section: typography
    reason: Existing Ant Design and Tailwind font stacks remain canonical; this repair introduces no font assets or typography tokens.
components:
  button: {}
  input: {}
  drawer: {}
  authPanel: {}
---

# Infinite Atelier design context

## Intent and scope

The application is a creative workbench, not an authentication landing-page redesign. Canvas and MONOFORM carry the expressive product identity. Account/security controls remain familiar, compact and explicit. The current task verifies the existing Codex integration flow without changing the canvas, marketing shell or design direction.

Supported UI locales are `zh-CN` and `en-US`; locale is not evidence of a geographic market. The default Chinese copy and English equivalents must describe the same operation and recovery path.

## Canonical runtime ownership — Model B

This file records existing values; it does not generate or replace the runtime theme.

| Role | Canonical source | Adapter/consumer |
| --- | --- | --- |
| Primary/elevated light and dark colors | `web/src/lib/app-theme.ts`, `neutral` | `getAntThemeConfig` → `AppProviders` → Ant Design components |
| CSS surfaces, text, border, focus and radius | `web/src/styles/globals.css` | CSS custom properties/Tailwind utilities |
| Control typography/radius | Ant Design theme through `AppProviders` | Button, Input and Drawer; do not override with a feature-specific font |
| Panel/code spacing | `codex-login-panel.tsx` existing `p-4`, `p-3`, `space-y-4` | One shared Codex login panel in both settings entry points |
| Auth helper/description text | `--muted-foreground` in `globals.css` | `text-muted-foreground`; contrast must be verified in both themes |
| Technical verification code | `font-mono` utility | Read-only selectable Input |
| Language and component locale | `web/src/i18n`, `AppProviders` | React i18next + matching Ant Design locale |

Do not hand-copy theme values into unrelated components. The frontmatter colors mirror `app-theme.ts`, and radius mirrors the CSS variable; component-specific Ant Design geometry remains library-owned.

## Components and presentation

- Use the existing Ant Design Button/Input/Drawer primitives. The channel editor owns the overlay and focus boundary.
- Use borders and neutral tonal surfaces for hierarchy; an OAuth fix must not introduce a new hero, gradient, typeface or provider-branded theme.
- Keep an official authorization destination visibly recognizable. Device codes are selectable text, never images or QR-only content.
- Lucide icons supplement labels, not replace them. Status and failure are text/live-region states, not color alone.
- Default, pending, disabled, read-only, copied, error and connected states are owned by `CodexLoginPanel` and its controller. Preserve input/code readability and keyboard access in light/dark themes and narrow viewports.
- Existing Drawer scrolling stays inside its established overlay; no fixed-height changes to shared page/tab ancestors. Reduced-motion rules remain owned by the global stylesheet and component library.

Observable behavior and security ownership are documented in `UX-CONTRACT.md`. Verification records are under `docs/superpowers/verification/`.
