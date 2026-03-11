import { sdk } from "@farcaster/miniapp-sdk";
import { useEffect, useState, useRef } from "react";
import { useAccount, useConnect } from "wagmi";

type Tab = 'node' | 'upgrade' | 'referral';
type User = any;

const API_URL = 'https://node-backend-tiff.onrender.com';

async function apiFetch(path: string, fid: number, wallet: string, body?: object) {
  const res = await fetch(`${API_URL}${path}`, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-fid': String(fid), 'x-wallet': wallet },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

const TIER_COLOR: Record<string, string> = { bronze: '#cd7f32', silver: '#94a3b8', gold: '#f59e0b', diamond: '#8b5cf6' };
const TIER_EMOJI: Record<string, string> = { bronze: '🥉', silver: '🥈', gold: '🥇', diamond: '💎' };
const TIER_MULTI: Record<string, number> = { bronze: 1, silver: 5, gold: 10, diamond: 30 };
const TIER_INTERVAL: Record<string, number> = { bronze: 60000, silver: 30000, gold: 30000, diamond: 30000 };

function fmt(s: number) {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}
function fmtCD(s: number) {
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

export default function App() {
  const { address, isConnected } = useAccount();
  const { connect, connectors } = useConnect();

  const [fid, setFid] = useState(0);
  const [user, setUser] = useState<User>(null);
  const [tab, setTab] = useState<Tab>('node');
  const [nodeOn, setNodeOn] = useState(false);
  const [uptime, setUptime] = useState(0);
  const [sessionPts, setSessionPts] = useState(0);
  const [claimReady, setClaimReady] = useState(false);
  const [claimCountdown, setClaimCountdown] = useState(0);
  const [leaderboard, setLeaderboard] = useState<any>(null);
  const [referrals, setReferrals] = useState<any>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [needsInvite, setNeedsInvite] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pulsing, setPulsing] = useState(false);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptimeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const claimRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const userTier = user?.tier || 'bronze';

  useEffect(() => {
    async function init() {
      await sdk.actions.ready();
      const ctx = await sdk.context;
      const userFid = ctx?.user?.fid || 0;
      setFid(userFid);
      if (!userFid) { setLoading(false); return; }
      if (!isConnected && connectors[0]) connect({ connector: connectors[0] });
      else setLoading(false);
    }
    init();
  }, []);

  useEffect(() => {
    if (address && fid) loadUser(fid, address);
  }, [address, fid]);

  async function loadUser(f: number, w: string) {
    setLoading(true);
    try {
      const data = await apiFetch('/user/me', f, w);
      if (data.user) {
        setUser(data.user);
        if (data.node?.is_active) {
          setNodeOn(true);
          const elapsed = data.node.started_at
            ? Math.floor((Date.now() - new Date(data.node.started_at).getTime()) / 1000)
            : 0;
          setUptime(elapsed);
          const earnedSoFar = Math.floor(elapsed / 30) * (TIER_MULTI[data.user.tier] || 1);
          setSessionPts(earnedSoFar);
          startTick(f, w, data.user.tier);
        }
        if (data.claim?.can_claim) setClaimReady(true);
        else if (data.claim?.next_claim_at) startClaimCd(new Date(data.claim.next_claim_at));
        const lb = await apiFetch('/leaderboard', f, w);
        setLeaderboard(lb);
      } else {
        setNeedsInvite(true);
      }
    } catch (_e) { setNeedsInvite(true); }
    setLoading(false);
  }

  function startTick(f: number, w: string, tier: string) {
    const multi = TIER_MULTI[tier] || 1;
    const interval = TIER_INTERVAL[tier] || 60000;
    tickRef.current = setInterval(async () => {
      await apiFetch('/node/tick', f, w, {});
      setSessionPts(p => p + multi);
      setPulsing(true);
      setTimeout(() => setPulsing(false), 600);
    }, interval);
    uptimeRef.current = setInterval(() => setUptime(u => u + 1), 1000);
  }

  function stopTick() {
    if (tickRef.current) clearInterval(tickRef.current);
    if (uptimeRef.current) clearInterval(uptimeRef.current);
  }

  function startClaimCd(next: Date) {
    const update = () => {
      const ms = next.getTime() - Date.now();
      if (ms <= 0) { setClaimReady(true); setClaimCountdown(0); if (claimRef.current) clearInterval(claimRef.current); }
      else setClaimCountdown(Math.floor(ms / 1000));
    };
    update();
    claimRef.current = setInterval(update, 1000);
  }

  async function handleRegister(skipInvite?: boolean) {
    if (!inviteCode.trim()) return setInviteError('Enter your invite code');
    if (!address) return setInviteError('Wallet not connected');
    setInviteError('');
    const check = await apiFetch(`/referral/resolve/${inviteCode.trim()}`, fid, address);
    if (!check.valid) return setInviteError(check.error || 'Invalid or already used code');
    const ctx = await sdk.context;
    const data = await apiFetch('/user/register', fid, address, {
      username: ctx?.user?.username || '',
      display_name: ctx?.user?.displayName || '',
      pfp_url: ctx?.user?.pfpUrl || '',
      fid,
      wallet: address,
      invite_code: inviteCode.trim(),
    });
    if (data.user) { setUser(data.user); setNeedsInvite(false); loadUser(fid, address); }
    else setInviteError(data.error || 'Registration failed');
  }

  async function handleToggleNode() {
    if (!address) return;
    if (nodeOn) {
      await apiFetch('/node/stop', fid, address, {});
      stopTick(); setNodeOn(false); setUptime(0); setSessionPts(0);
    } else {
      const res = await apiFetch('/node/start', fid, address, {});
      if (res.success) { setNodeOn(true); startTick(fid, address, userTier); setClaimReady(false); }
    }
  }

  async function handleClaim() {
    if (!claimReady || !address) return;
    const res = await apiFetch('/node/claim', fid, address, {});
    if (res.success) {
      setUser((u: User) => ({ ...u, points: res.total_points }));
      setNodeOn(false); stopTick(); setUptime(0); setSessionPts(0); setClaimReady(false);
      if (res.next_claim_at) startClaimCd(new Date(res.next_claim_at));
    }
  }

  async function handleUpgrade(tier: string, _priceUsdc: number) {
    if (!address) return;
    const amounts: Record<string, string> = { silver: '5000000', gold: '15000000', diamond: '30000000' };
    const amount = amounts[tier];
    if (!amount) return;
    try {
      const result = await sdk.actions.sendToken({
        token: 'eip155:8453/erc20:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        amount,
        recipientAddress: '0x7E6B746c463BDe6B5718d8296f0B0B05B5b64f0a',
      });
      const txHash = (result as any)?.send?.transaction;
      if (!txHash) return;
      const res = await apiFetch('/payment/verify', fid, address, { tier, tx_hash: txHash });
      if (res.success) {
        setUser((u: User) => ({ ...u, tier: res.tier, invite_slots: res.invite_slots }));
        setTab('node');
      }
    } catch (e) { console.error(e); }
  }

  async function handleTabChange(t: Tab) {
    setTab(t);
    if (t === 'referral' && !referrals && address) {
      const data = await apiFetch('/referral/my', fid, address);
      setReferrals(data);
    }
  }

  if (loading) return (
    <div style={S.center}>
      <div style={S.bigN}>N</div>
      <div style={S.loadTxt}>LOADING NODE...</div>
    </div>
  );

  if (!isConnected || !address) return (
    <div style={S.center}>
      <div style={S.bigN}>N</div>
      <div style={S.invTitle}>NODE</div>
      <div style={S.invSub}>Connect your wallet to continue</div>
      <button style={S.invBtn} onClick={() => connect({ connector: connectors[0] })}>Connect Wallet</button>
    </div>
  );

  if (needsInvite) return (
    <div style={S.center}>
      <div style={S.bigN}>N</div>
      <div style={S.invTitle}>NODE</div>
      <div style={S.invSub}>Invite only. Get a code from an existing member.</div>
      <input
        style={S.invInput}
        placeholder="Enter invite code (PRX-XXXXXX)"
        value={inviteCode}
        onChange={e => setInviteCode(e.target.value.toUpperCase())}
        onKeyDown={e => { if (e.key === 'Enter') handleRegister(); }}
      />
      {inviteError && <div style={S.invErr}>{inviteError}</div>}
      <button style={S.invBtn} onClick={() => handleRegister(false)}>Enter Node</button>
      <button style={{...S.invBtn, background: 'transparent', border: '1px solid #333', color: '#fff', marginTop: 8}} onClick={() => handleRegister(true)}>Skip — Join as Bronze</button>
      <div style={S.invWallet}>{address.slice(0,6)}...{address.slice(-4)}</div>
    </div>
  );

  const pts = user?.points || 0;
  const invLeft = (user?.invite_slots || 0) - (user?.invites_used || 0);

  return (
    <div style={S.app}>
      <div style={S.header}>
        <div style={S.hLogo}>
          <span style={S.hN}>N</span>
          <span style={S.hText}>NODE</span>
        </div>
        <div style={S.hRight}>
          <span style={{ fontSize: 16 }}>{TIER_EMOJI[userTier]}</span>
          <span style={S.hPts}>{pts.toLocaleString()} PTS</span>
        </div>
      </div>

      <div style={S.content}>
        {tab === 'node' && (
          <div>
            <div style={S.ptsCard}>
              <div style={S.lbl}>TOTAL POINTS</div>
              <div style={{ ...S.ptsNum, color: pulsing ? '#06b6d4' : '#ffffff' }}>{pts.toLocaleString()}</div>
              <div style={S.sub}>≈ {pts.toLocaleString()} $NODE at TGE</div>
              <div style={S.progTrack}>
                <div style={{ ...S.progFill, width: `${Math.min((pts / 50000) * 100, 100)}%` }} />
              </div>
              <div style={S.tierRow}>
                {['bronze','silver','gold','diamond'].map(t => (
                  <div key={t} style={{ ...S.tierChip, ...(userTier === t ? { borderColor: TIER_COLOR[t], color: TIER_COLOR[t] } : {}) }}>
                    {TIER_EMOJI[t]}
                  </div>
                ))}
              </div>
            </div>

            <div style={S.nodeCard}>
              <div style={S.nodeTopRow}>
                <span style={S.lbl}>NODE STATUS</span>
                <div style={{ ...S.badge, ...(nodeOn ? S.badgeOn : {}) }}>
                  <div style={{ ...S.dot, ...(nodeOn ? S.dotOn : {}) }} />
                  {nodeOn ? 'ONLINE' : 'OFFLINE'}
                </div>
              </div>
              <div style={{ ...S.nBtn, ...(nodeOn ? S.nBtnOn : {}) }} onClick={handleToggleNode}>
                <div style={{ ...S.nGlyph, ...(nodeOn ? S.nGlyphOn : {}) }}>N</div>
                <div style={S.nSub}>{nodeOn ? 'RUNNING' : 'TAP TO START'}</div>
              </div>
              <div style={S.uptimeTxt}>{fmt(uptime)}</div>
              <div style={S.statsGrid}>
                <div style={S.statBox}><span style={S.statV}>+{sessionPts}</span><span style={S.statL}>Session</span></div>
                <div style={S.statBox}><span style={{ ...S.statV, color: TIER_COLOR[userTier] }}>{userTier.toUpperCase()}</span><span style={S.statL}>Tier</span></div>
                <div style={S.statBox}><span style={S.statV}>{invLeft}</span><span style={S.statL}>Invites</span></div>
              </div>
            </div>

            <div style={S.actions}>
              <button style={nodeOn ? S.btnSec : S.btnPri} onClick={handleToggleNode}>
                {nodeOn ? 'Stop Node' : 'Start Node'}
              </button>
              <button style={claimReady ? S.btnCyan : S.btnDis} onClick={handleClaim} disabled={!claimReady}>
                {claimReady ? 'Claim Points' : claimCountdown > 0 ? `Next claim in ${fmtCD(claimCountdown)}` : 'Claim Points'}
              </button>
            </div>

            <div style={S.section}>
              <div style={S.secTitle}>Leaderboard</div>
              {leaderboard ? (
                <div>
                  {leaderboard.top100?.slice(0, 10).map((u: any) => (
                    <div key={u.fid} style={{ ...S.lbRow, ...(u.fid === fid ? S.lbYou : {}) }}>
                      <span style={S.lbRank}>#{u.rank}</span>
                      <div style={S.lbInfo}>
                        <div style={S.lbName}>{u.display_name || u.username || `User ${u.fid}`}</div>
                        <div style={S.lbHandle}>@{u.username} · {TIER_EMOJI[u.tier]}</div>
                      </div>
                      <div style={S.lbPts}>{u.points.toLocaleString()}</div>
                    </div>
                  ))}
                  {leaderboard.me && leaderboard.me.rank > 10 && (
                    <div style={{ ...S.lbRow, ...S.lbYou, marginTop: 12 }}>
                      <span style={S.lbRank}>#{leaderboard.me.rank}</span>
                      <div style={S.lbInfo}>
                        <div style={S.lbName}>{user?.display_name || user?.username}<span style={S.youPill}>YOU</span></div>
                        <div style={S.lbHandle}>@{user?.username} · {TIER_EMOJI[userTier]}</div>
                      </div>
                      <div style={S.lbPts}>{pts.toLocaleString()}</div>
                    </div>
                  )}
                </div>
              ) : <div style={S.loadTxt}>Loading...</div>}
            </div>
          </div>
        )}

        {tab === 'upgrade' && (
          <div style={{ padding: 16 }}>
            <div style={S.pageTitle}>Upgrade Node</div>
            <div style={S.pageSub}>One-time payment in USDC on Base</div>
            {[
              { tier: 'bronze',  price: 'Free',      mult: '1x',  claim: 'Every 6h',  invites: '0',      desc: 'Basic node. Restart required after each claim.' },
              { tier: 'silver',  price: '$5 USDC',   mult: '5x',  claim: 'Every 12h', invites: '5',      desc: '5x multiplier. 5 invite slots.' },
              { tier: 'gold',    price: '$15 USDC',  mult: '10x', claim: 'Every 24h', invites: '10',     desc: '10x multiplier. 10 invite slots.' },
              { tier: 'diamond', price: '$30 USDC',  mult: '30x', claim: 'Auto',      invites: '20/day', desc: 'Auto-claim. Affiliate earnings. 20 invites/24h auto-refill.' },
            ].map(t => (
              <div key={t.tier} style={{ ...S.tierCard, borderColor: userTier === t.tier ? TIER_COLOR[t.tier] : '#1a1a1a' }}>
                <div style={S.tcTop}>
                  <span style={{ fontSize: 28 }}>{TIER_EMOJI[t.tier]}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ ...S.tcName, color: TIER_COLOR[t.tier] }}>{t.tier.toUpperCase()}</div>
                    <div style={S.tcPrice}>{t.price}</div>
                  </div>
                  {userTier === t.tier && <div style={S.curBadge}>Current</div>}
                </div>
                <div style={S.tcMeta}>
                  <span style={S.tcTag}>{t.mult} multiplier</span>
                  <span style={S.tcTag}>Claim {t.claim}</span>
                  <span style={S.tcTag}>{t.invites} invites</span>
                </div>
                <div style={S.tcDesc}>{t.desc}</div>
                <button
                  style={userTier === t.tier || t.tier === 'bronze'
                    ? { ...S.btnDis, margin: '0 16px 16px', width: 'calc(100% - 32px)' }
                    : { ...S.btnPri, margin: '0 16px 16px', width: 'calc(100% - 32px)' }}
                  onClick={() => t.tier !== 'bronze' && userTier !== t.tier && handleUpgrade(t.tier, t.tier === 'silver' ? 5 : t.tier === 'gold' ? 15 : 30)} disabled={userTier === t.tier || t.tier === 'bronze'}
                >
                  {userTier === t.tier ? 'Current Tier' : t.tier === 'bronze' ? 'Free' : `Upgrade to ${t.tier.charAt(0).toUpperCase() + t.tier.slice(1)}`}
                </button>
              </div>
            ))}
          </div>
        )}

        {tab === 'referral' && (
          <div style={{ padding: 16 }}>
            <div style={S.pageTitle}>Referrals</div>
            <div style={S.pageSub}>Each invite code is single-use — one person per code</div>

            <div style={S.ptsCard}>
              <div style={S.lbl}>REFERRAL EARNINGS</div>
              <div style={{ ...S.ptsNum, fontSize: 36 }}>
                ${((referrals?.total_usdc_earned || 0) / 1e6).toFixed(2)}
                <span style={{ fontSize: 16, color: '#06b6d4' }}> USDC</span>
              </div>
              <div style={S.sub}>From referral upgrades on Base</div>
            </div>

            <div style={{ ...S.statsGrid, margin: '12px 0' }}>
              <div style={S.statBox}><span style={{ ...S.statV, color: '#10b981' }}>{referrals?.total_referrals || 0}</span><span style={S.statL}>Referrals</span></div>
              <div style={S.statBox}><span style={{ ...S.statV, color: '#06b6d4' }}>+{referrals?.total_points_earned || 0}</span><span style={S.statL}>Bonus Pts</span></div>
              <div style={S.statBox}><span style={{ ...S.statV, color: '#8b5cf6' }}>{invLeft}</span><span style={S.statL}>Slots Left</span></div>
            </div>

            <div style={S.ptsCard}>
              <div style={S.lbl}>YOUR INVITE CODE</div>
              <div style={S.codeRow}>
                <div style={S.codeVal}>{user?.active_invite_code || 'No slots remaining'}</div>
                <button style={S.copyBtn} onClick={() => sdk.actions.openUrl(`https://warpcast.com/~/compose?text=Join Node with my invite code: ${user?.referral_code || ''}`)}>Share</button>
              </div>
              <div style={{ fontSize: 11, color: '#555', marginTop: 8 }}>Single-use — once someone uses your code it's locked to them</div>
            </div>

            {referrals?.referrals?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={S.secTitle}>Your Referrals</div>
                {referrals.referrals.map((r: any, i: number) => (
                  <div key={i} style={S.lbRow}>
                    <div style={S.lbInfo}>
                      <div style={S.lbName}>{r.user?.display_name || r.user?.username}</div>
                      <div style={S.lbHandle}>@{r.user?.username} · {TIER_EMOJI[r.user?.tier || 'bronze']}</div>
                    </div>
                    <div style={{ color: '#10b981', fontFamily: 'monospace', fontSize: 13 }}>+${(r.usdc_earned / 1e6).toFixed(2)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={S.bottomNav}>
        {(['node','upgrade','referral'] as Tab[]).map(t => (
          <div key={t} style={{ ...S.navItem, ...(tab === t ? S.navActive : {}) }} onClick={() => handleTabChange(t)}>
            <span style={{ ...S.navIcon, ...(tab === t ? S.navIconOn : {}) }}>
              {t === 'node' ? 'N' : t === 'upgrade' ? '◈' : '◎'}
            </span>
            <span style={{ ...S.navLbl, ...(tab === t ? S.navLblOn : {}) }}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  app:       { background: '#000', minHeight: '100vh', maxWidth: 430, margin: '0 auto', color: '#fff', fontFamily: 'system-ui,sans-serif', paddingBottom: 76 },
  center:    { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#000', padding: 24 },
  bigN:      { fontSize: 80, fontWeight: 900, color: '#06b6d4', lineHeight: 1, marginBottom: 8 },
  loadTxt:   { fontFamily: 'monospace', fontSize: 12, color: '#555', letterSpacing: 2 },
  invTitle:  { fontSize: 26, fontWeight: 700, letterSpacing: 8, marginBottom: 10 },
  invSub:    { fontSize: 13, color: '#555', textAlign: 'center', marginBottom: 28, lineHeight: 1.6 },
  invInput:  { width: '100%', background: '#111', border: '1px solid #333', color: '#fff', fontFamily: 'monospace', fontSize: 14, padding: '12px 16px', borderRadius: 10, outline: 'none', marginBottom: 8, letterSpacing: 1, boxSizing: 'border-box' },
  invErr:    { color: '#ef4444', fontSize: 12, marginBottom: 10 },
  invBtn:    { width: '100%', padding: 14, background: '#fff', border: 'none', borderRadius: 12, color: '#000', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  invWallet: { fontFamily: 'monospace', fontSize: 11, color: '#444', marginTop: 16 },

  header:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'rgba(0,0,0,0.96)', borderBottom: '1px solid #1a1a1a', position: 'sticky', top: 0, zIndex: 100 },
  hLogo:   { display: 'flex', alignItems: 'center', gap: 8 },
  hN:      { fontSize: 22, fontWeight: 900, color: '#06b6d4' },
  hText:   { fontFamily: 'monospace', fontSize: 13, letterSpacing: 3 },
  hRight:  { display: 'flex', alignItems: 'center', gap: 8 },
  hPts:    { fontFamily: 'monospace', fontSize: 12, color: '#06b6d4' },
  content: { paddingBottom: 16 },

  ptsCard:   { margin: 16, background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 16, padding: 20 },
  lbl:       { fontFamily: 'monospace', fontSize: 9, color: '#555', letterSpacing: 2, marginBottom: 4 },
  ptsNum:    { fontFamily: 'monospace', fontSize: 40, fontWeight: 500, lineHeight: 1, marginBottom: 4, transition: 'color 0.3s' },
  sub:       { fontFamily: 'monospace', fontSize: 11, color: '#06b6d4', marginBottom: 14 },
  progTrack: { height: 3, background: '#1a1a1a', borderRadius: 99, marginBottom: 14, overflow: 'hidden' },
  progFill:  { height: '100%', background: '#06b6d4', borderRadius: 99, transition: 'width 1s ease' },
  tierRow:   { display: 'flex', gap: 6 },
  tierChip:  { flex: 1, padding: '6px 4px', borderRadius: 8, textAlign: 'center', border: '1px solid #1a1a1a', background: '#000', fontSize: 16 },

  nodeCard:    { margin: '0 16px 12px', background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 16, padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center' },
  nodeTopRow:  { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 24 },
  badge:       { display: 'flex', alignItems: 'center', gap: 5, fontFamily: 'monospace', fontSize: 10, color: '#555', background: '#000', border: '1px solid #222', padding: '4px 10px', borderRadius: 99 },
  badgeOn:     { color: '#06b6d4', borderColor: 'rgba(6,182,212,0.4)', background: 'rgba(6,182,212,0.06)' },
  dot:         { width: 6, height: 6, borderRadius: '50%', background: '#555' },
  dotOn:       { background: '#06b6d4' },
  nBtn:        { width: 160, height: 160, borderRadius: '50%', background: '#000', border: '2px solid #222', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', marginBottom: 16, transition: 'all 0.4s' },
  nBtnOn:      { borderColor: '#06b6d4', boxShadow: '0 0 40px rgba(6,182,212,0.35), 0 0 80px rgba(6,182,212,0.15)' },
  nGlyph:      { fontSize: 58, fontWeight: 900, color: '#2a2a2a', lineHeight: 1, transition: 'all 0.4s' },
  nGlyphOn:    { color: '#06b6d4' },
  nSub:        { fontFamily: 'monospace', fontSize: 8, color: '#444', letterSpacing: 2, marginTop: 4 },
  uptimeTxt:   { fontFamily: 'monospace', fontSize: 13, color: '#06b6d4', letterSpacing: 2, marginBottom: 16 },
  statsGrid:   { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, width: '100%' },
  statBox:     { background: '#000', border: '1px solid #1a1a1a', borderRadius: 10, padding: '10px 8px', textAlign: 'center' },
  statV:       { fontFamily: 'monospace', fontSize: 15, color: '#fff', display: 'block', marginBottom: 3, fontWeight: 500 },
  statL:       { fontSize: 9, color: '#555', letterSpacing: 0.5 },

  actions:    { margin: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8 },
  btnPri:     { width: '100%', padding: 14, background: '#fff', border: 'none', borderRadius: 12, color: '#000', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnSec:     { width: '100%', padding: 14, background: 'transparent', border: '1px solid #333', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnCyan:    { width: '100%', padding: 14, background: '#06b6d4', border: 'none', borderRadius: 12, color: '#000', fontSize: 14, fontWeight: 700, cursor: 'pointer' },
  btnDis:     { width: '100%', padding: 14, background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 12, color: '#444', fontSize: 14, cursor: 'not-allowed' },

  section:   { padding: '0 16px 16px' },
  secTitle:  { fontSize: 14, fontWeight: 700, marginBottom: 10 },
  pageTitle: { fontSize: 20, fontWeight: 700, marginBottom: 4 },
  pageSub:   { fontSize: 13, color: '#555', marginBottom: 20 },

  lbRow:   { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: 10, marginBottom: 4 },
  lbYou:   { borderColor: 'rgba(6,182,212,0.4)', background: 'rgba(6,182,212,0.04)' },
  lbRank:  { fontFamily: 'monospace', fontSize: 11, color: '#555', width: 28, flexShrink: 0 },
  lbInfo:  { flex: 1, minWidth: 0 },
  lbName:  { fontSize: 13, fontWeight: 500 },
  lbHandle:{ fontFamily: 'monospace', fontSize: 10, color: '#555' },
  lbPts:   { fontFamily: 'monospace', fontSize: 13, fontWeight: 500 },
  youPill: { fontFamily: 'monospace', fontSize: 9, color: '#06b6d4', background: 'rgba(6,182,212,0.1)', border: '1px solid rgba(6,182,212,0.3)', padding: '1px 6px', borderRadius: 99, marginLeft: 6 },

  tierCard: { border: '1px solid #1a1a1a', background: '#0a0a0a', borderRadius: 16, marginBottom: 12, overflow: 'hidden' },
  tcTop:    { padding: '16px 16px 8px', display: 'flex', alignItems: 'center', gap: 12 },
  tcName:   { fontSize: 13, fontWeight: 700, letterSpacing: 1, marginBottom: 2 },
  tcPrice:  { fontFamily: 'monospace', fontSize: 18 },
  tcMeta:   { padding: '0 16px 8px', display: 'flex', gap: 6, flexWrap: 'wrap' },
  tcTag:    { fontFamily: 'monospace', fontSize: 10, color: '#555', background: '#000', border: '1px solid #1a1a1a', padding: '3px 8px', borderRadius: 99 },
  tcDesc:   { padding: '0 16px 12px', fontSize: 12, color: '#666', lineHeight: 1.6 },
  curBadge: { fontFamily: 'monospace', fontSize: 9, color: '#06b6d4', background: 'rgba(6,182,212,0.08)', border: '1px solid rgba(6,182,212,0.3)', padding: '3px 8px', borderRadius: 99 },

  codeRow:  { display: 'flex', gap: 8, marginTop: 10 },
  codeVal:  { flex: 1, background: '#000', border: '1px solid #333', color: '#06b6d4', fontFamily: 'monospace', fontSize: 14, padding: '10px 12px', borderRadius: 8 },
  copyBtn:  { background: '#fff', border: 'none', color: '#000', fontWeight: 700, fontSize: 13, padding: '10px 16px', borderRadius: 8, cursor: 'pointer' },

  bottomNav: { position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)', width: '100%', maxWidth: 430, background: 'rgba(0,0,0,0.97)', borderTop: '1px solid #1a1a1a', display: 'flex', zIndex: 300 },
  navItem:   { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 8px 10px', cursor: 'pointer', gap: 4 },
  navActive: { borderTop: '2px solid #06b6d4' },
  navIcon:   { fontSize: 20, fontWeight: 900, color: '#333' },
  navIconOn: { color: '#06b6d4' },
  navLbl:    { fontSize: 10, color: '#333', letterSpacing: 0.3 },
  navLblOn:  { color: '#06b6d4' },
};
