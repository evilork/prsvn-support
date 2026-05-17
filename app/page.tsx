// app/page.tsx
export default function Home() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: 480,
        margin: '8rem auto',
        padding: '2rem',
        textAlign: 'center',
        color: '#222',
      }}
    >
      <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>
        ProxysVPN Support
      </h1>
      <p style={{ color: '#666', marginBottom: '2rem' }}>
        Бот поддержки. Напишите в Telegram.
      </p>
      <a
        href="https://t.me/proxysvpn_support_bot"
        style={{
          display: 'inline-block',
          padding: '0.75rem 1.5rem',
          background: '#229ED9',
          color: '#fff',
          borderRadius: '8px',
          textDecoration: 'none',
          fontWeight: 600,
        }}
      >
        Открыть в Telegram
      </a>
    </main>
  );
}
