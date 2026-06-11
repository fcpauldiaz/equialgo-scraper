export type SchwabOAuthPageVariant = "success" | "error";

export interface RenderSchwabOAuthPageParams {
  variant: SchwabOAuthPageVariant;
  title: string;
  message: string;
  detail?: string;
  notifySuccess?: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PAGE_STYLES = `
  :root {
    --color-paper:      oklch(12% 0.008 160);
    --color-paper-2:    oklch(16% 0.010 160);
    --color-paper-3:    oklch(20% 0.010 160);
    --color-ink:        oklch(92% 0.006 160);
    --color-ink-2:      oklch(72% 0.006 160);
    --color-rule:       oklch(28% 0.008 160);
    --color-accent:     oklch(72% 0.19 155);
    --color-positive:   oklch(72% 0.17 145);
    --color-negative:   oklch(65% 0.20 25);
    --font-display: "Space Grotesk", system-ui, sans-serif;
    --font-body:    "Inter Tight", system-ui, sans-serif;
    --font-mono:    "JetBrains Mono", ui-monospace, monospace;
    --space-3xs: 0.25rem;
    --space-2xs: 0.5rem;
    --space-xs:  0.75rem;
    --space-sm:  1rem;
    --space-md:  1.5rem;
    --space-lg:  2rem;
    --text-sm:      0.8125rem;
    --text-md:      0.9375rem;
    --text-xl:      1.375rem;
    --radius-card:  8px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: var(--font-body);
    font-size: var(--text-md);
    line-height: 1.55;
    color: var(--color-ink);
    background: var(--color-paper);
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-md);
    -webkit-font-smoothing: antialiased;
  }
  .oauth-shell {
    width: 100%;
    max-width: 420px;
  }
  .oauth-brand {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-accent);
    margin: 0 0 var(--space-sm);
  }
  .oauth-card {
    background: var(--color-paper-2);
    border: 1px solid var(--color-rule);
    border-radius: var(--radius-card);
    padding: var(--space-lg);
  }
  .oauth-card h1 {
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: -0.02em;
    margin: 0 0 var(--space-3xs);
    color: var(--color-ink);
  }
  .oauth-card h1.success { color: var(--color-positive); }
  .oauth-card h1.error { color: var(--color-negative); }
  .oauth-card p {
    margin: 0 0 var(--space-xs);
    color: var(--color-ink-2);
    font-size: var(--text-sm);
  }
  .oauth-card p:last-child { margin-bottom: 0; }
  .oauth-detail {
    margin-top: var(--space-sm);
    padding: var(--space-xs) var(--space-sm);
    background: var(--color-paper-3);
    border: 1px solid var(--color-rule);
    border-radius: var(--radius-card);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    color: var(--color-ink-2);
    word-break: break-word;
  }
  .oauth-hint {
    margin-top: var(--space-md);
    font-size: var(--text-sm);
    color: var(--color-ink-2);
  }
`;

const POST_MESSAGE_SCRIPT = (success: boolean) =>
  `<script>if (window.opener) window.opener.postMessage({ type: 'schwab-login-done', success: ${success} }, '*');</script>`;

export function renderSchwabOAuthPage(params: RenderSchwabOAuthPageParams): string {
  const titleClass = params.variant;
  const detailBlock = params.detail
    ? `<div class="oauth-detail">${escapeHtml(params.detail)}</div>`
    : "";
  const hint =
    params.variant === "success"
      ? `<p class="oauth-hint">You can close this tab and return to EquiAlgo.</p>`
      : "";
  const notifySuccess = params.notifySuccess ?? params.variant === "success";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@500;700&family=Inter+Tight:wght@400;500&display=swap" rel="stylesheet" />
  <title>${escapeHtml(params.title)} – EquiAlgo</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <main class="oauth-shell">
    <p class="oauth-brand">EquiAlgo · Schwab</p>
    <div class="oauth-card">
      <h1 class="${titleClass}">${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.message)}</p>
      ${detailBlock}
      ${hint}
    </div>
  </main>
  ${POST_MESSAGE_SCRIPT(notifySuccess)}
</body>
</html>`;
}
