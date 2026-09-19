# Infinite Atelier Workspace Entry Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the promotional home page with a Chinese-first workspace entry that surfaces recent canvases, quick-start actions, and an in-app new-canvas flow without changing canvas data or generation services.

**Architecture:** Keep `/` as the workspace entry route. Move global navigation into a responsive desktop side rail plus the existing mobile drawer/header pattern, then split the home UI into a presentational workspace entry, a new-canvas modal, and a small pure project-view model. Reuse `CanvasProject`, `createProject`, `readCanvasPackage`, `importProject`, and the existing Prompt Library instead of introducing new persistence or server APIs.

**Tech Stack:** React 19, TypeScript, React Router, Zustand, Ant Design, Tailwind CSS v4, react-i18next, Vitest, existing local-first canvas persistence.

All `npm` commands below run from `/Users/hwang/无限画布/infinite-atelier/web`.

---

## File map

- Create `web/src/pages/home/workspace-entry-model.ts` for pure sorting, limits, and project presentation data.
- Create `web/src/pages/home/workspace-entry-model.test.ts` for deterministic project-view tests.
- Create `web/src/components/home/workspace-entry.tsx` for the presentational workspace-entry layout.
- Create `web/src/components/home/new-canvas-dialog.tsx` for the three-option in-app modal.
- Create `web/src/components/layout/app-side-nav.tsx` for the desktop navigation rail.
- Modify `web/src/pages/home/index.tsx` to own page state, project actions, import input, and Prompt Library handoff.
- Modify `web/src/pages/canvas/index.tsx` to reuse the shared import action and keep the existing canvas library behavior.
- Modify `web/src/layouts/user-layout.tsx` to place the side rail beside the content column.
- Modify `web/src/components/layout/app-top-nav.tsx` to become the compact mobile header and retain account/status controls.
- Modify `web/src/components/layout/mobile-nav-drawer.tsx` to use the new Chinese group labels while preserving the current drawer behavior.
- Modify `web/src/i18n/locales/zh-CN.ts` and `web/src/i18n/locales/en-US.ts` for all new menu, action, status, and modal copy.
- Modify `web/src/styles/globals.css` to remove the obsolete promotional home CSS and add only shared workspace-shell rules that Tailwind cannot express cleanly.
- Modify `DESIGN.md` to make the workspace entry and side navigation the canonical shell contract.

## Task 1: Lock the project-view model with tests

**Files:**
- Create: `web/src/pages/home/workspace-entry-model.ts`
- Test: `web/src/pages/home/workspace-entry-model.test.ts`

- [ ] **Step 1: Write failing tests for recent-project selection**

Use the real `CanvasProject` shape with a small fixture factory. The tests must verify that the helper sorts by descending `updatedAt`, returns at most three projects, and does not mutate the source array.

```ts
import { describe, expect, it } from "vitest";

import { getRecentProjects } from "./workspace-entry-model";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

const project = (id: string, updatedAt: string): CanvasProject => ({
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    nodes: [],
    connections: [],
    chatSessions: [],
    activeChatId: null,
    backgroundMode: "lines",
    showImageInfo: false,
    viewport: { x: 0, y: 0, k: 1 },
});

describe("getRecentProjects", () => {
    it("sorts newest first, limits to three, and preserves input order", () => {
        const source = [
            project("old", "2026-06-10T00:00:00.000Z"),
            project("newest", "2026-06-19T00:00:00.000Z"),
            project("middle", "2026-06-15T00:00:00.000Z"),
            project("fourth", "2026-06-12T00:00:00.000Z"),
        ];

        expect(getRecentProjects(source).map(({ id }) => id)).toEqual(["newest", "middle", "fourth"]);
        expect(source.map(({ id }) => id)).toEqual(["old", "newest", "middle", "fourth"]);
    });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `web/`:

```bash
npm run test:unit -- src/pages/home/workspace-entry-model.test.ts
```

Expected: FAIL because `./workspace-entry-model` does not exist.

- [ ] **Step 3: Implement the minimal pure model**

Add the following exported functions:

```ts
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

export function getRecentProjects(projects: CanvasProject[], limit = 3): CanvasProject[] {
    return [...projects].sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()).slice(0, limit);
}

export function getProjectNodeSummary(project: CanvasProject): { nodes: number; connections: number } {
    return { nodes: project.nodes.length, connections: project.connections.length };
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
npm run test:unit -- src/pages/home/workspace-entry-model.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the model and test**

```bash
git add web/src/pages/home/workspace-entry-model.ts web/src/pages/home/workspace-entry-model.test.ts
git commit -m "test: define workspace entry project model"
```

## Task 2: Create the responsive navigation shell

**Files:**
- Create: `web/src/components/layout/app-side-nav.tsx`
- Modify: `web/src/layouts/user-layout.tsx`
- Modify: `web/src/components/layout/app-top-nav.tsx`
- Modify: `web/src/components/layout/mobile-nav-drawer.tsx`
- Modify: `web/src/i18n/locales/zh-CN.ts`
- Modify: `web/src/i18n/locales/en-US.ts`

- [ ] **Step 1: Add the navigation copy before wiring JSX**

Add locale keys under `topNav` for `workspace`, `system`, `createCanvas`, and `accountStatus`, plus the existing navigation labels in Chinese/English. Keep the meanings aligned:

```ts
topNav: {
    workspace: "工作区",
    system: "系统",
    createCanvas: "新建画布",
    accountStatus: "本地优先",
    // existing keys remain unchanged
}
```

The English locale must use `Workspace`, `System`, `Create canvas`, and `Local-first`.

- [ ] **Step 2: Implement the desktop side rail**

Create `AppSideNav` with `useLocation`, the existing `navigationTools`, `useCanvasStore`, and `useAccountAction`. It owns the global “新建画布” action so it can be used from every non-detail route; it must:

```tsx
export function AppSideNav() {
    const { pathname } = useLocation();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useAccountAction(useCanvasStore((state) => state.createProject));
    const activeToolSlug = pathname.split("/").filter(Boolean)[0] as NavigationToolSlug | undefined;
    const createAndEnter = () => navigate(`/canvas/${createProject(t("canvas.defaultTitle", { count: projects.length + 1 }))}`);

    return (
        <aside className="hidden h-dvh w-60 shrink-0 flex-col border-r border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950 md:flex">
            {/* brand, primary create action, grouped navigation, spacer, account/status controls */}
        </aside>
    );
}
```

Use a text label beside every icon, an explicit selected state, and a real `<button>` for “新建画布”. Render `UserStatusActions` at the bottom without duplicating account logic.

- [ ] **Step 3: Move the layout split into `UserLayout`**

Change the outer layout to render `<AppSideNav />` beside the content column. The content column remains `min-w-0 flex-1 flex-col overflow-hidden`; `NavigationSaveGuard` remains outside it. The side rail owns the existing `CanvasProject` store action, so `UserLayout` does not need a new prop or a second project store.

- [ ] **Step 4: Make the existing top navigation mobile-only**

Keep `AppTopNav` as the compact mobile header with the menu trigger and `UserStatusActions`; hide it at `md` and preserve the current canvas-detail route behavior. Keep `MobileNavDrawer` as the accessible mobile route chooser, but use the new localized group/title copy and preserve its close-on-navigation behavior.

- [ ] **Step 5: Render the shell at server markup level**

Add a focused SSR test in `web/src/components/layout/app-side-nav.test.tsx` using `renderToStaticMarkup`, mocking `react-router-dom`, `react-i18next`, and `UserStatusActions` as the existing account tests do. The core assertion should look like:

```tsx
const html = renderToStaticMarkup(<AppSideNav />);
expect(html).toContain("工作区");
expect(html).toContain('aria-label="新建画布"');
expect(html).toMatch(/>画布</);
expect(html).toMatch(/>导演</);
expect(html).toMatch(/>资产</);
expect(html).toMatch(/>配置</);
```

- [ ] **Step 6: Run navigation tests and typecheck**

```bash
npm run test:unit -- src/components/layout/app-side-nav.test.tsx
npm run typecheck
```

Expected: PASS with no new TypeScript errors.

- [ ] **Step 7: Commit the navigation shell**

```bash
git add web/src/components/layout/app-side-nav.tsx web/src/components/layout/app-side-nav.test.tsx web/src/layouts/user-layout.tsx web/src/components/layout/app-top-nav.tsx web/src/components/layout/mobile-nav-drawer.tsx web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "feat: add Chinese-first workspace navigation"
```

## Task 3: Extract the shared canvas-package import action

**Files:**
- Create: `web/src/hooks/use-canvas-archive-import.ts`
- Modify: `web/src/pages/canvas/index.tsx`
- Modify: `web/src/pages/home/index.tsx`

- [ ] **Step 1: Move the existing import behavior behind one hook**

The hook must own the hidden input ref, `readCanvasPackage`, account-scoped `importProject`, localized success/error messages, and input reset:

```ts
export function useCanvasArchiveImport() {
    const inputRef = useRef<HTMLInputElement>(null);
    const { message } = App.useApp();
    const { t } = useTranslation();
    const importProject = useAccountAction(useCanvasStore((state) => state.importProject));

    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const importedProjects = await readCanvasPackage(file);
            importedProjects.forEach((project) => importProject(project));
            message.success(t("canvas.imported", { count: importedProjects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    return { inputRef, openImport: () => inputRef.current?.click(), importCanvas };
}
```

- [ ] **Step 2: Replace `CanvasPage`’s local duplicate**

Keep its current import button and hidden input semantics, but call `openImport` and `importCanvas(event.target.files?.[0])`. Do not change existing project selection, export, rename, or delete behavior.

- [ ] **Step 3: Wire the same action into the new home entry**

The workspace entry’s “导入参考” quick action must open the same hidden input. It must not create a new import parser or persistence path.

- [ ] **Step 4: Run archive-import and type tests**

```bash
npm run test:unit -- src/services/account-archive-import.test.ts src/pages/home/workspace-entry-model.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the shared action**

```bash
git add web/src/hooks/use-canvas-archive-import.ts web/src/pages/canvas/index.tsx web/src/pages/home/index.tsx
git commit -m "refactor: share canvas archive import action"
```

## Task 4: Build the workspace entry and new-canvas modal

**Files:**
- Create: `web/src/components/home/new-canvas-dialog.tsx`
- Create: `web/src/components/home/workspace-entry.tsx`
- Modify: `web/src/pages/home/index.tsx`
- Modify: `web/src/components/home/prompt-library-section.tsx` only if an anchor wrapper is required.

- [ ] **Step 1: Add the modal component with explicit action props**

Implement `NewCanvasDialog` with this contract:

```ts
type NewCanvasDialogProps = {
    open: boolean;
    onClose: () => void;
    onCreateBlank: () => void;
    onImportReference: () => void;
    onStartFromPrompt: () => void;
};
```

Use Ant Design `Modal` with `footer={null}`, `centered`, `destroyOnHidden`, and localized labels. Each option must be a labeled button with a short description and visible hover/focus state. The modal must not perform work on mount.

- [ ] **Step 2: Build the presentational workspace entry**

Keep store and navigation side effects out of the visual component. Use this prop contract so the states can be rendered in SSR tests:

```ts
type WorkspaceEntryProps = {
    hydrated: boolean;
    recentProjects: CanvasProject[];
    onOpenNewCanvas: () => void;
    onCreateCanvas: () => void;
    onOpenProject: (id: string) => void;
    onOpenCanvasLibrary: () => void;
    onImportReference: () => void;
    onStartFromPrompt: () => void;
};
```

The component renders the Pencil-approved structure: title/actions, featured recent project or empty state, quick-start row, recent project grid, and the localized labels from `useTranslation`.

- [ ] **Step 3: Replace the promotional home container**

Replace the current palette state, animated editorial hero, and full home prompt section placement with a functional page using:

```tsx
const projects = useCanvasStore((state) => state.projects);
const hydrated = useCanvasStore((state) => state.hydrated);
const recentProjects = getRecentProjects(projects);
const [newCanvasOpen, setNewCanvasOpen] = useState(false);
```

The page passes the state and callbacks into `WorkspaceEntry` and must render:

- a workspace title row with localized search placeholder and import action;
- a featured recent project card or empty state;
- quick-start actions for blank, import, and prompt;
- a recent-project grid using the existing project data;
- the existing Prompt Library below the workspace entry, wrapped by `id="prompt-library"` if needed.

Use `onOpenNewCanvas={() => setNewCanvasOpen(true)}` for the prominent home action and render `NewCanvasDialog` beside the entry. The dialog’s blank option calls `createProject` and then `navigate(`/canvas/${id}`)`; its import option closes the dialog before opening the shared file input. Use `navigate("/canvas")` for “查看全部”. The prompt action should scroll to the existing Prompt Library anchor rather than creating a second prompt data source.

- [ ] **Step 4: Preserve loading, empty, and failure states**

While `hydrated` is false, render a text status region. When there are no projects, show one primary new-canvas action. Import failures must use the existing app message feedback. Buttons must expose accessible names; icon-only overflow affordances need `aria-label` and a tooltip/title.

- [ ] **Step 5: Add the new home copy to both locales**

Add matching `home.workspaceEntry`, `home.continueCreating`, `home.quickStart`, `home.recentCanvases`, `home.importReference`, `home.startFromPrompt`, `home.openProject`, `home.emptyDescription`, `home.loading`, and modal option keys to `zh-CN.ts` and `en-US.ts`. Do not leave the visible menu/action copy hard-coded in the component.

- [ ] **Step 6: Add SSR coverage for the key states**

Create `web/src/components/home/workspace-entry.test.tsx` with `renderToStaticMarkup` fixtures for:

1. hydrated projects: contains 继续创作, 最近画布, and the project title;
2. no projects: contains the empty-state action and does not contain the old Hero headline;
3. loading: contains the loading status and does not render an empty ambiguity.

Render the presentational component directly with the prop contract above and mock only `react-i18next`; do not duplicate the Zustand implementation in the test. The empty-state assertion should be:

```tsx
const html = renderToStaticMarkup(
    <WorkspaceEntry hydrated recentProjects={[]} onOpenNewCanvas={() => {}} onCreateCanvas={() => {}} onOpenProject={() => {}} onOpenCanvasLibrary={() => {}} onImportReference={() => {}} onStartFromPrompt={() => {}} />,
);
expect(html).toContain("还没有画布项目");
expect(html).not.toContain("把灵感变成可以持续推演的作品");
```

- [ ] **Step 7: Run focused home tests and typecheck**

```bash
npm run test:unit -- src/pages/home/workspace-entry-model.test.ts src/components/home/workspace-entry.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit the workspace entry**

```bash
git add web/src/components/home/new-canvas-dialog.tsx web/src/components/home/workspace-entry.tsx web/src/components/home/workspace-entry.test.tsx web/src/pages/home/index.tsx web/src/components/home/prompt-library-section.tsx web/src/pages/home/workspace-entry-model.ts web/src/i18n/locales/zh-CN.ts web/src/i18n/locales/en-US.ts
git commit -m "feat: replace promotional home with workspace entry"
```

## Task 5: Reconcile visual tokens and remove legacy home styling

**Files:**
- Modify: `web/src/styles/globals.css`
- Modify: `DESIGN.md`

- [ ] **Step 1: Remove only obsolete promotional home rules**

Delete the old `.home-editorial-hero`, film grain, running-line, palette animation, stage animation, and home-specific keyframes that are no longer referenced by the new page. Do not remove shared theme variables, reduced-motion rules, canvas styles, or Prompt Library styles still used below the entry.

- [ ] **Step 2: Add the canonical workspace-shell rules**

Keep the implementation mostly in existing Tailwind utilities. Add only shared rules for the side rail height/scroll containment, the workspace entry preview thumbnail treatment, and reduced-motion behavior if static analysis shows utilities are insufficient. Reuse the existing `--background`, `--foreground`, `--border`, and accent tokens.

- [ ] **Step 3: Update `DESIGN.md` ownership**

Replace the statement that the current task must not change the marketing shell with the new canonical contract: the root route is a functional workspace entry, the side rail owns product navigation, and the Pencil design file is the visual source for this change. Keep the existing neutral palette, Ant Design control ownership, locale parity, and account/security boundaries.

- [ ] **Step 4: Run static style checks**

```bash
if rg -n "home-editorial-hero|home-film-grain|home-running-line|home-stage-|home-silk-light|home-display-title" web/src; then exit 1; else echo "no obsolete promotional home selectors"; fi
npm run format:check
```

Expected: no references to deleted promotional selectors; formatter passes.

- [ ] **Step 5: Commit the style reconciliation**

```bash
git add web/src/styles/globals.css DESIGN.md
git commit -m "refactor: align workspace entry styling contract"
```

## Task 6: Verify the complete workflow

**Files:**
- Modify only if verification finds a defect in the files above.

- [ ] **Step 1: Run the focused unit and SSR tests**

```bash
cd web
npm run test:unit -- src/pages/home/workspace-entry-model.test.ts src/pages/home/workspace-entry.test.tsx src/components/layout/app-side-nav.test.tsx src/services/account-archive-import.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run repository typecheck, format, and production build**

```bash
npm run typecheck
npm run format:check
npm run build
```

Expected: all commands exit successfully.

- [ ] **Step 3: Exercise the browser workflow**

Start the existing web app and verify in a real browser:

- `/` opens with the workspace entry and no promotional Hero;
- Chinese menu labels are visible in the desktop side rail;
- the mobile menu opens and closes with keyboard access;
- recent project cards open the correct `/canvas/:id`;
- zero-project empty state creates exactly one project;
- the new-canvas modal opens, closes, and does not create a project until an option is selected;
- blank canvas creation navigates to the new project;
- import opens the file chooser and shows the existing success/error feedback;
- prompt action reaches the existing Prompt Library;
- `/canvas`, `/director`, `/assets`, and `/config` remain reachable;
- `/canvas/:id` keeps the canvas-specific chrome and is not covered by the side rail;
- a narrow viewport has no clipped controls or accidental horizontal scroll.

- [ ] **Step 4: Run the strict UI audit required by the design system**

```bash
python /Users/hwang/.codex/plugins/cache/openai-curated-remote/frontend-design-premium/1.4.0/skills/scripts/audit_project.py /Users/hwang/无限画布/infinite-atelier --mode strict
```

Keep the JSON output as verification evidence, fix blocking findings, and repeat the audit.

- [ ] **Step 5: Review the final diff and status**

```bash
git diff --check fork/main...HEAD
git status --short --branch
```

Confirm that unrelated generated files remain unmodified and that the final diff contains only the workspace entry redesign, its tests, localized copy, style contract, and shared import extraction.

- [ ] **Step 6: Commit any verification fixes**

```bash
git add web/src DESIGN.md
git commit -m "fix: complete workspace entry verification"
```
