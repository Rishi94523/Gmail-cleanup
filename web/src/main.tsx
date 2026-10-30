import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type IconName = 'mail' | 'arrow' | 'check' | 'shield' | 'sun' | 'spark' | 'undo' | 'clock' | 'sliders';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    arrow: (
      <>
        <path d="M4 12h16M14 6l6 6-6 6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    shield: (
      <>
        <path d="m12 3 8 3v6c0 4-8 9-8 9s-8-5-8-9V6z" />
        <path d="m8 11 3 3 5-5" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2" />
      </>
    ),
    spark: <path d="m12 2 2.7 7.3L22 12l-7.3 2.7L12 22l-2.7-7.3L2 12l7.3-2.7z" />,
    undo: (
      <>
        <path d="M3 10h11a6 6 0 0 1 0 12M3 10l5-5M3 10l5 5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v6l4 2" />
      </>
    ),
    sliders: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="8" cy="7" r="2" />
        <circle cx="16" cy="17" r="2" />
      </>
    )
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
const examples = [
  {
    title: 'A sale you forgot you signed up for.',
    sender: 'Example promotion',
    category: 'Promotions',
    age: '8 months ago',
    letter: 'p',
    color: 'peach'
  },
  {
    title: 'Someone liked something. Again.',
    sender: 'Example social notification',
    category: 'Social updates',
    age: '6 months ago',
    letter: 's',
    color: 'lavender'
  },
  {
    title: 'Your favorite Sunday read.',
    sender: 'Example newsletter',
    category: 'Protected sender',
    age: 'Last Sunday',
    letter: 'n',
    color: 'sage'
  }
];

function AgentDemo() {
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(!window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setFrame(value => (value + 1) % 26), 1000);
    return () => window.clearInterval(timer);
  }, [playing]);
  const asking = frame < 14;
  const second = frame >= 7;
  const chosen = asking && frame % 7 >= 4;
  const title = second ? 'How should I handle routine product updates?' : 'How should I handle product announcements?';
  const options = ['Keep in inbox', 'Mark as read', 'Archive'];
  const answer = second ? 1 : 2;
  const processed = Math.max(0, Math.min(3, Math.floor((frame - 16) / 2) + 1));
  const rows = [
    { sender: 'Studio Notes', subject: 'Introducing our latest collection', action: 'Archived', icon: 'archive' },
    { sender: 'Your Workspace', subject: 'Here’s what’s new this month', action: 'Marked as read', icon: 'read' },
    { sender: 'The Sunday Letter', subject: 'A story worth sitting with', action: 'Kept in inbox', icon: 'keep' }
  ];
  return (
    <div
      className="agent-demo reveal"
      id="agent-demo"
      data-playing={playing}
      data-stage={asking ? 'questions' : 'cleanup'}
    >
      <div className="demo-toolbar">
        <span>
          <Icon name="spark" size={17} /> A little help, in motion
        </span>
        <span className="demo-example">EXAMPLE INBOX</span>
        <button
          className="demo-play"
          onClick={() => setPlaying(value => !value)}
          aria-label={playing ? 'Pause demo' : 'Play demo'}
        >
          {playing ? 'Pause' : 'Play'} <span aria-hidden="true">{playing ? 'Ⅱ' : '▷'}</span>
        </button>
      </div>
      <div className="demo-scenes">
        <div className="demo-conversation">
          <div className={`demo-agent ${asking ? '' : 'is-thinking'}`}>
            <Icon name="spark" size={28} />
          </div>
          <p className="eyebrow">
            {asking
              ? `GETTING TO KNOW YOU · ${second ? '2' : '1'} OF 2`
              : frame < 17
                ? 'CONNECTING THE DOTS'
                : 'FOLLOWING YOUR PREFERENCES'}
          </p>
          {asking ? (
            <>
              <h3 key={title}>{title}</h3>
              <p>
                {second
                  ? 'You receive recurring updates from products you use. What would you like me to do with them?'
                  : 'Your inbox includes product launches and feature announcements. How would you like similar emails handled?'}
              </p>
              <div className="demo-options">
                {options.map((option, index) => (
                  <div key={option} className={`demo-option ${chosen && index === answer ? 'selected' : ''}`}>
                    <span className="demo-radio">{chosen && index === answer ? '✓' : ''}</span>
                    {option}
                  </div>
                ))}
                <span
                  className={`demo-cursor ${second ? 'at-read' : 'at-archive'} ${chosen ? 'clicked' : ''} ${frame % 7 < 2 ? 'approaching' : ''}`}
                  aria-hidden="true"
                >
                  <svg width="25" height="32" viewBox="0 0 25 32">
                    <path d="M2 2v25l7-7 5 10 5-3-5-9h10Z" fill="#294f3f" stroke="#fcfdf8" strokeWidth="2" />
                  </svg>
                </span>
              </div>
              <div className="demo-answer-status">
                {chosen ? 'Preference saved for similar emails.' : 'Your agent asks. You decide.'}
              </div>
            </>
          ) : (
            <>
              <h3>
                {frame < 17
                  ? 'A moment to think.'
                  : processed === 3
                    ? 'Room for what matters.'
                    : 'Making a little room.'}
              </h3>
              <p>
                {frame < 17
                  ? 'Reading each email with your preferences in mind.'
                  : `${processed} checked · ${Math.min(processed, 2)} tidied · ${processed === 3 ? 1 : 0} kept`}
              </p>
              <div className="demo-thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <p className="demo-cleanup-note">Nothing deleted. Your important mail stays.</p>
            </>
          )}
        </div>
        <div className="demo-inbox">
          <div className="demo-inbox-title">
            <Icon name="mail" size={19} />
            <strong>Your Primary inbox</strong>
            <span>{3 - Math.min(processed, 2)} unread</span>
          </div>
          {rows.map((row, index) => (
            <div key={row.sender} className={`demo-email ${!asking && processed > index ? `decided ${row.icon}` : ''}`}>
              <span className="demo-avatar">{row.sender[0]}</span>
              <div>
                <strong>{row.sender}</strong>
                <p>{row.subject}</p>
                <span className="demo-decision">
                  {!asking && processed > index ? (
                    <>
                      <Icon name="check" size={13} />
                      {row.action}
                    </>
                  ) : (
                    'Waiting for your agent'
                  )}
                </span>
              </div>
            </div>
          ))}
          <div className="demo-inbox-foot">
            <Icon name="shield" size={15} /> Your choices guide every decision.
          </div>
        </div>
      </div>
      <div className="demo-footer">
        <span>Illustrative demo · no Gmail access</span>
        <button
          className="subtle-link"
          onClick={() => {
            setFrame(0);
            setPlaying(true);
          }}
        >
          Replay ↻
        </button>
      </div>
    </div>
  );
}

function App() {
  const [daily, setDaily] = useState(true);
  const [hour, setHour] = useState('10:00');
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  useEffect(() => {
    const observer = new IntersectionObserver(
      entries =>
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            observer.unobserve(entry.target);
          }
        }),
      { threshold: 0.08 }
    );
    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);
  const connect = () => {
    window.location.assign('/auth/google');
  };
  const faqs = [
    [
      'Will it delete my emails?',
      'No. Choose mark as read, archive, or both for low-priority emails. Cleanup adds a “Cleaned by agent” label and records changes for undo. Nothing is deleted.'
    ],
    [
      'What will the AI be allowed to do?',
      'Connect Gmail, allow AI analysis, and choose what matters to you. Each cleanup checks up to 100 unread emails in Primary. Important and uncertain mail stays. Unsubscribing requires its own permission.'
    ],
    [
      'Will it work while my browser is closed?',
      'Yes. Enable your daily routine and choose a time and timezone. Your agent checks new unread Primary mail using your saved preferences, even while your browser is closed.'
    ],
    [
      'Can I connect Gmail today?',
      'Yes. Connect Gmail, allow AI analysis, answer general preference questions, then start a cleanup of up to 100 unread Primary emails. Google currently allows only accounts added as test users.'
    ]
  ];
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header wrap">
        <a href="#" className="logo" aria-label="Inboxclean home">
          <span>
            <Icon name="mail" size={20} />
          </span>
          inboxclean<span className="logo-dot">.</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#your-rules">Your rules</a>
          <a href="#daily">Daily fresh start</a>
        </nav>
        <a className="header-workspace" href="/app">
          My workspace <Icon name="arrow" size={15} />
        </a>
      </header>
      <main id="main">
        <section className="hero wrap">
          <div className="hero-copy">
            <div className="release-note">
              <span className="status-dot" />A quieter kind of email assistant
            </div>
            <h1>
              Your inbox.
              <br />
              Back in <em>your hands.</em>
            </h1>
            <p>
              Too much mail. Too little headspace.
              <br />
              Let an AI assistant find the noise, follow your rules,
              <br className="desktop-break" /> and make room for what matters.
            </p>
            <div className="hero-actions">
              <button className="button" onClick={connect}>
                Connect Gmail <Icon name="arrow" size={18} />
              </button>
              <a className="subtle-link" href="#agent-demo">
                See it in action <span>↗</span>
              </a>
            </div>
            <div className="hero-assurance">
              <Icon name="shield" size={14} />
              <span>Your rules. Your approval. A little more peace.</span>
            </div>
          </div>
          <div className="hero-visual" aria-label="Illustration of user-controlled inbox cleanup">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <span className="visual-spark spark-one">✳</span>
            <span className="visual-spark spark-two">✧</span>
            <div className="floating-note note-top">
              <span className="mini-icon">
                <Icon name="shield" size={15} />
              </span>
              Important mail stays.<span className="tiny-check">✓</span>
            </div>
            <div className="mail-window">
              <div className="window-top">
                <span className="window-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>Your inbox, feeling lighter</span>
                <Icon name="spark" size={13} />
              </div>
              <div className="window-heading">
                <div>
                  <small>A LITTLE BREATHING ROOM</small>
                  <h2>Keep the good stuff.</h2>
                </div>
                <span className="window-badge">Your call</span>
              </div>
              <div className="mini-mails">
                {examples.map((item, i) => (
                  <div className={`mini-mail mail-${i}`} key={item.sender}>
                    <span className={`letter ${item.color}`}>{item.letter}</span>
                    <div>
                      <strong>{item.sender}</strong>
                      <span>{item.title}</span>
                    </div>
                    <span className={`mini-decision ${i === 2 ? 'keep' : ''}`}>{i === 2 ? 'Keep ♡' : 'Tidy up'}</span>
                  </div>
                ))}
              </div>
              <div className="window-bottom">
                <Icon name="check" size={14} />
                <span>You decide what goes. We do the tidying.</span>
              </div>
            </div>
            <div className="floating-note note-bottom">
              <span className="mini-sun">
                <Icon name="sun" size={21} />
              </span>
              <div>
                <strong>A daily fresh start</strong>
                <small>Every morning. On your terms.</small>
              </div>
              <span className="note-time">10:00</span>
            </div>
            <span className="illustration-label">YOUR INBOX, WITH A LITTLE HELP</span>
          </div>
        </section>
        <div className="principles wrap reveal">
          <span>
            <Icon name="shield" size={17} /> Important emails, protected.
          </span>
          <span>
            <Icon name="sliders" size={17} /> You’re always in control.
          </span>
          <span>
            <Icon name="undo" size={17} /> Archive first. Keep a way back.
          </span>
        </div>
        <section className="how-section wrap reveal" id="how-it-works">
          <div className="section-intro">
            <p className="eyebrow">FROM OVERWHELMED TO UNDER CONTROL</p>
            <h2>
              An inbox that knows
              <br />
              what matters to you.
            </h2>
            <p>
              Designed for the inbox you’ve been
              <br />
              meaning to deal with. For a while.
            </p>
          </div>
          <div className="how-steps">
            <article>
              <span className="step-number">01</span>
              <div>
                <h3>Connect your Gmail.</h3>
                <p>One secure Google connection. Your assistant finds patterns in the clutter, so you don’t have to.</p>
              </div>
            </article>
            <article>
              <span className="step-number">02</span>
              <div>
                <h3>Tell it what matters.</h3>
                <p>
                  Review recommendations. Choose what to archive, what to mark read, and which subscriptions to leave.
                </p>
              </div>
            </article>
            <article>
              <span className="step-number">03</span>
              <div>
                <h3>Try your first 100.</h3>
                <p>
                  Your agent checks up to 100 unread emails in Primary. Keep a daily routine or start another cleanup
                  when you need one.
                </p>
              </div>
            </article>
          </div>
        </section>
        <section className="control-section" id="your-rules">
          <div className="wrap">
            <div className="control-heading reveal">
              <div>
                <p className="eyebrow">YOUR PREFERENCES. A LITTLE LESS CLUTTER.</p>
                <h2>
                  Watch your agent
                  <br />
                  <em>find its rhythm.</em>
                </h2>
              </div>
              <p>
                A few questions, based on your inbox.
                <br />
                Then thoughtful decisions, one email at a time.
              </p>
            </div>
            <AgentDemo />
          </div>
        </section>
        <section className="daily-section wrap reveal" id="daily">
          <div className="daily-visual">
            <div className="sun-disc">
              <Icon name="sun" size={54} />
            </div>
            <div className="schedule-card">
              <div>
                <span>
                  <Icon name="clock" size={16} /> YOUR DAILY ROUTINE
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={daily}
                    onChange={e => setDaily(e.target.checked)}
                    aria-label="Enable example daily routine"
                  />
                  <i />
                </label>
              </div>
              <label htmlFor="daily-time">A fresh start, every morning.</label>
              <div className="time-picker">
                <input id="daily-time" type="time" value={hour} onChange={e => setHour(e.target.value || '10:00')} />
                <span>Your local time</span>
              </div>
              <div className="schedule-days" aria-hidden="true">
                {'MTWTFSS'.split('').map((day, i) => (
                  <span key={i} className={daily ? 'enabled' : ''}>
                    {day}
                  </span>
                ))}
              </div>
              <p>
                <span className={`status-dot ${daily ? '' : 'paused'}`} />
                {daily ? `Example routine set for ${hour} daily` : 'Example routine paused'}
              </p>
            </div>
            <span className="daily-flower">✳</span>
          </div>
          <div className="daily-copy">
            <p className="eyebrow">ONE LESS THING ON YOUR LIST</p>
            <h2>
              A calmer inbox.
              <br />
              Even on busy days.
            </h2>
            <p>
              Your assistant wakes up at your chosen time, applies your approved rules, and leaves a clear record of
              what changed.
            </p>
            <ul>
              <li>
                <Icon name="check" size={16} />
                Your time. Your timezone.
              </li>
              <li>
                <Icon name="check" size={16} />
                Review uncertain mail instead of guessing.
              </li>
              <li>
                <Icon name="check" size={16} />
                Pause whenever you want.
              </li>
            </ul>
            <span className="development-note">Choose your time. Pause whenever you need.</span>
          </div>
        </section>
        <section className="faq-section wrap reveal">
          <div>
            <p className="eyebrow">A FEW THINGS YOU MIGHT WONDER</p>
            <h2>
              Good questions.
              <br />
              Clear answers.
            </h2>
          </div>
          <div className="faqs">
            {faqs.map(([question, answer], i) => (
              <article className={openFaq === i ? 'open' : ''} key={question}>
                <h3>
                  <button
                    aria-expanded={openFaq === i}
                    aria-controls={`faq-${i}`}
                    onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  >
                    {question}
                    <span>{openFaq === i ? '−' : '+'}</span>
                  </button>
                </h3>
                <div id={`faq-${i}`} className="faq-answer" hidden={openFaq !== i}>
                  <p>{answer}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section className="closing-section wrap reveal">
          <Icon name="spark" size={30} />
          <p className="eyebrow">LESS INBOX. MORE OUTSIDE THE INBOX.</p>
          <h2>
            Make room for
            <br />
            <em>something better.</em>
          </h2>
          <button className="button" onClick={connect}>
            Connect Gmail <Icon name="arrow" size={18} />
          </button>
          <p>Connect Gmail. Set your preferences. Clean up to 100 unread Primary emails.</p>
        </section>
      </main>
      <footer className="site-footer wrap">
        <a href="#" className="logo">
          <span>
            <Icon name="mail" size={18} />
          </span>
          inboxclean<span className="logo-dot">.</span>
        </a>
        <p>Thoughtfully built. A little lighter.</p>
        <nav className="footer-legal" aria-label="Legal and contact">
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
          <a href="mailto:rishidv2005@gmail.com">Contact</a>
        </nav>
        <span>© {new Date().getFullYear()} Inboxclean · A quieter inbox, every day.</span>
      </footer>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
