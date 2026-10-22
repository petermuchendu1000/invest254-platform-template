'use client';

// Last-resort boundary for failures in the root layout itself. It must render
// its own <html>/<body> because the normal layout has crashed.
export default function GlobalError({ error }: { error: Error; reset: () => void }) {
  /**
   * RELOAD means reload.
   *
   * This used to call Next's `reset()`, which re-renders the same crashed tree in the same
   * document. That recovers a one-off render error and does nothing at all for the kind of failure
   * that actually reaches this screen: a module that threw on evaluation, a bad persisted value, a
   * hook used outside its provider. Those re-throw on the first render after the reset, so the
   * screen redrew itself and the button looked dead. Reported as exactly that: "reload button never
   * fires anything."
   *
   * A full document load is the only thing that clears module state, and it is what the sentence
   * above the button already promises. The error is logged first, because a reload throws the
   * console away and this screen is the last place the cause is visible.
   */
  const reload = () => {
    try { console.error('[global-error] reloading after', error); } catch { /* console may be gone */ }
    window.location.reload();
  };
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '1rem',
          background: '#07090f',
          color: '#e6edf3',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: '1.5rem',
        }}
      >
        <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>Invest254 hit a problem</h1>
        <p style={{ maxWidth: '24rem', color: '#8b949e', fontSize: '0.875rem' }}>
          The app failed to load. Please reload. Your account and balance are safe.
        </p>
        <button
          onClick={reload}
          style={{
            height: '2.75rem',
            padding: '0 1.25rem',
            borderRadius: '0.75rem',
            border: 'none',
            background: '#00a859',
            color: '#fff',
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          Reload
        </button>
      </body>
    </html>
  );
}
