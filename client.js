// SPDX-License-Identifier: MIT
// CodeBuddy collaboration panel.
// The pill (composer dock) and the panel (above the composer) both read one
// host-polled store, so they can never disagree with the host or each other.
// Data: the most recent bridged rounds, parsed from the CLI's own transcript.
window.__ModuleLoader__.load({
  id: 'dsh-codebuddy-bridge',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/plugins/codebuddy-bridge/last-run';
    const POLL_MS = 4000;
    const sessions = new Map();

    function entry(sessionId) {
      let record = sessions.get(sessionId);
      if (!record) {
        record = {
          state: { enabled: false, runs: [], model: '', models: [], timing: null },
          listeners: new Set(),
          timer: undefined,
          busy: false,
          version: 0,
        };
        sessions.set(sessionId, record);
      }
      return record;
    }

    function notify(sessionId) {
      for (const listener of [...entry(sessionId).listeners]) {
        try {
          listener();
        } catch {
          /* one broken subscriber must not block the rest */
        }
      }
    }

    // A poll that started before a click must not overwrite the click's result.
    async function pull(sessionId) {
      const record = entry(sessionId);
      const version = record.version;
      try {
        const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, {
          credentials: 'same-origin',
        });
        const body = await response.json();
        if (record.version !== version) return;
        record.state = {
          enabled: body?.enabled === true,
          runs: Array.isArray(body?.runs) ? body.runs : [],
          model: typeof body?.model === 'string' ? body.model : '',
          models: Array.isArray(body?.models) ? body.models : [],
          timing: body?.timing && typeof body.timing === 'object' ? body.timing : null,
        };
        notify(sessionId);
      } catch {
        /* keep the previous snapshot */
      }
    }

    function ensurePolling(sessionId) {
      const record = entry(sessionId);
      if (record.timer) return;
      void pull(sessionId);
      record.timer = setInterval(() => void pull(sessionId), POLL_MS);
    }

    function stopPolling(sessionId) {
      const record = entry(sessionId);
      if (record.timer) clearInterval(record.timer);
      record.timer = undefined;
    }

    function useWorkBuddy(sessionId) {
      const [, bump] = React.useState(0);
      React.useEffect(() => {
        if (!sessionId) return undefined;
        const record = entry(sessionId);
        const listener = () => bump((value) => value + 1);
        record.listeners.add(listener);
        ensurePolling(sessionId);
        return () => {
          record.listeners.delete(listener);
          if (record.listeners.size === 0) stopPolling(sessionId);
        };
      }, [sessionId]);
      return entry(sessionId).state;
    }

    async function flip(sessionId, target) {
      const record = entry(sessionId);
      if (record.busy) return;
      record.busy = true;
      record.version += 1;
      const previous = record.state.enabled;
      record.state = { ...record.state, enabled: target };
      notify(sessionId);
      try {
        await fetch('/plugins/codebuddy-bridge/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId, enabled: target }),
        });
      } catch {
        record.state = { ...record.state, enabled: previous };
        notify(sessionId);
      } finally {
        record.busy = false;
      }
      record.version += 1;
      await pull(sessionId);
    }

    async function setModel(sessionId, model) {
      const record = entry(sessionId);
      record.state = { ...record.state, model };
      notify(sessionId);
      try {
        await fetch('/plugins/codebuddy-bridge/model', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ model }),
        });
      } catch {
        /* the next poll restores the host value */
      }
      record.version += 1;
      await pull(sessionId);
    }

    const pill = (on) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      padding: '3px 10px',
      borderRadius: 999,
      border: `1px solid ${on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
      background: on ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
      color: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
      fontSize: 12,
      fontWeight: 600,
      lineHeight: '18px',
      cursor: 'pointer',
      userSelect: 'none',
    });
    const dot = (on) => ({
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
    });

    function Toggle(props) {
      const sessionId = props?.sessionId;
      const { enabled } = useWorkBuddy(sessionId);
      return h(
        'button',
        {
          type: 'button',
          style: pill(enabled),
          title: enabled ? '关闭 CodeBuddy 协作（工具一起收走）' : '开启 CodeBuddy 协作',
          onClick: () => void flip(sessionId, !enabled),
        },
        h('span', { style: dot(enabled) }),
        enabled ? 'CodeBuddy 协作 · 开' : 'CodeBuddy 协作',
      );
    }

    const panelStyle = {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 760,
      margin: '0 auto 8px',
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-1)',
      borderRadius: 12,
      padding: '10px 14px',
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      fontSize: 13,
      color: 'var(--dsw-alias-label-primary)',
    };
    const header = {
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontWeight: 600,
      cursor: 'pointer',
      userSelect: 'none',
    };
    const row = { display: 'flex', gap: 8, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' };
    const stepText = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    };
    const tag = {
      flex: '0 0 auto',
      fontSize: 11,
      lineHeight: '16px',
      padding: '0 6px',
      borderRadius: 4,
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-brand-primary)',
      fontWeight: 600,
    };
    const older = { ...row, opacity: 0.7, fontSize: 12 };
    const timingStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      fontSize: 11,
      lineHeight: '16px',
      color: 'var(--dsw-alias-label-secondary)',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    };
    const summaryStyle = {
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-secondary)',
      borderTop: '1px solid var(--dsw-alias-border-l1)',
      paddingTop: 6,
      marginTop: 2,
      whiteSpace: 'pre-wrap',
    };

    function timeOf(run) {
      if (!run || typeof run.at !== 'number') return '';
      const date = new Date(run.at);
      return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }

    function secondsOf(run) {
      if (!run || typeof run.startedAt !== 'number' || typeof run.endedAt !== 'number') return '';
      const seconds = Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000));
      return seconds ? `${seconds}s` : '';
    }

    function stepsOf(run) {
      return run && Array.isArray(run.steps) ? run.steps : [];
    }

    // "思考 vs WorkBuddy" for the whole session. Kept on one line under the
    // header so it is visible without opening the panel.
    const TIMING_TITLE =
      '本会话时间拆分：思考 = step/start→assistant/message；WorkBuddy = workbuddy_* 工具调用；' +
      '其它 = 读文件、命令等工具。不含你打字的时间。';

    function minutesOf(ms) {
      const value = Number(ms) || 0;
      if (value < 60_000) return `${Math.round(value / 1000)}s`;
      return `${(value / 60_000).toFixed(1)}m`;
    }

    function timingText(timing) {
      if (!timing || timing.available !== true) return '';
      const ratio =
        timing.workbuddyMs > 0 && timing.thinkMs > 0
          ? ` · ${(timing.thinkMs / timing.workbuddyMs).toFixed(1)}:1`
          : '';
      return (
        `思考 ${minutesOf(timing.thinkMs)}` +
        ` · WorkBuddy ${minutesOf(timing.workbuddyMs)}` +
        ` · 其它 ${minutesOf(timing.otherMs)}` +
        ratio
      );
    }

    const selectStyle = {
      marginLeft: 8,
      fontSize: 11,
      padding: '1px 4px',
      borderRadius: 4,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-secondary)',
      cursor: 'pointer',
    };

    const BODY_LIMITS = { min: 48, max: 420, initial: 168 };

    const bodyStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: 5,
      overflowY: 'auto',
      overscrollBehavior: 'contain',
      paddingRight: 2,
    };
    const gripStyle = {
      height: 8,
      marginBottom: 2,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'ns-resize',
      touchAction: 'none',
    };
    const gripBar = { width: 36, height: 3, borderRadius: 2, background: 'var(--dsw-alias-border-l1)' };
    const titleButton = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      border: 0,
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontWeight: 600,
      cursor: 'pointer',
      padding: 0,
    };

    function stored(key, fallback) {
      try {
        const raw = window.localStorage.getItem(key);
        return raw === null ? fallback : raw;
      } catch {
        return fallback;
      }
    }

    function storeValue(key, value) {
      try {
        window.localStorage.setItem(key, String(value));
      } catch {
        /* storage may be unavailable; the panel still works this session */
      }
    }

    function Panel(props) {
      const sessionId = props?.sessionId;
      const { enabled, runs, model, models, timing } = useWorkBuddy(sessionId);
      const [open, setOpen] = React.useState(() => stored('workbuddy.panel.open', '1') !== '0');
      const [bodyHeight, setBodyHeight] = React.useState(() => {
        const saved = Number(stored('workbuddy.panel.height', BODY_LIMITS.initial));
        if (!Number.isFinite(saved)) return BODY_LIMITS.initial;
        return Math.min(BODY_LIMITS.max, Math.max(BODY_LIMITS.min, saved));
      });
      const heightRef = React.useRef(bodyHeight);
      React.useEffect(() => {
        heightRef.current = bodyHeight;
      }, [bodyHeight]);

      if (!enabled) return null;
      const latest = runs.length > 0 ? runs[runs.length - 1] : null;
      const earlier = runs.slice(0, -1).slice(-5).reverse();
      const meta = latest
        ? [timeOf(latest), `${latest.stepCount ?? stepsOf(latest).length} 个工具`, secondsOf(latest)]
            .filter(Boolean)
            .join(' · ')
        : '还没有协作记录';
      const statsText = timingText(timing);

      const toggle = () =>
        setOpen((value) => {
          storeValue('workbuddy.panel.open', value ? '0' : '1');
          return !value;
        });

      const startDrag = (event) => {
        event.preventDefault();
        const startY = event.clientY;
        const startHeight = heightRef.current;
        const move = (moveEvent) => {
          // The handle sits on the top edge: dragging up makes the card taller.
          const next = Math.min(
            BODY_LIMITS.max,
            Math.max(BODY_LIMITS.min, startHeight - (moveEvent.clientY - startY)),
          );
          heightRef.current = next;
          setBodyHeight(next);
        };
        const stop = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', stop);
          storeValue('workbuddy.panel.height', heightRef.current);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', stop);
      };

      const resetHeight = () => {
        heightRef.current = BODY_LIMITS.initial;
        setBodyHeight(BODY_LIMITS.initial);
        storeValue('workbuddy.panel.height', BODY_LIMITS.initial);
      };

      const stepRows = latest
        ? stepsOf(latest)
            .slice(-6)
            .map((step, index) =>
              h(
                'div',
                { key: `s${index}`, style: row },
                h('span', { style: tag }, step.tag),
                h('span', { style: stepText }, step.text),
              ),
            )
        : [h('div', { key: 'none', style: row }, '开一轮协作后，这里会列出它做了什么。')];

      return h(
        'div',
        { style: panelStyle, 'data-workbuddy-panel': 'on' },
        h(
          'div',
          {
            key: 'grip',
            style: gripStyle,
            title: '往上拖变高、往下拖变矮 · 双击复位',
            onPointerDown: startDrag,
            onDoubleClick: resetHeight,
          },
          h('span', { style: gripBar }),
        ),
        h(
          'div',
          { style: { ...header, cursor: 'default' } },
          h(
            'button',
            {
              type: 'button',
              style: titleButton,
              title: open ? '收起面板' : '展开面板',
              'aria-expanded': open,
              onClick: toggle,
            },
            h('span', { style: dot(true) }),
            h('span', null, 'CodeBuddy 协作'),
            h('span', { style: { ...row, fontSize: 11 } }, open ? '▾' : '▸'),
          ),
          h('span', { style: { ...row, marginLeft: 'auto' } }, meta),
          h(
            'select',
            {
              value: model,
              style: selectStyle,
              title: 'WorkBuddy 这一轮用哪个模型（全局生效）',
              onChange: (event) => void setModel(sessionId, event.target.value),
              onClick: (event) => event.stopPropagation(),
            },
            h('option', { value: '' }, '默认模型'),
            ...models.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
          ),
        ),
        statsText
          ? h('div', { key: 'timing', style: timingStyle, title: TIMING_TITLE, 'data-workbuddy-timing': 'on' }, statsText)
          : null,
        ...(open
          ? [
              h(
                'div',
                { key: 'body', style: { ...bodyStyle, maxHeight: bodyHeight } },
                ...stepRows,
                latest && latest.summary
                  ? h('div', { key: 'sum', style: summaryStyle }, String(latest.summary).slice(0, 200))
                  : null,
                ...(earlier.length > 0
                  ? [
                      h('div', { key: 'sep', style: { ...row, marginTop: 4 } }, `更早的 ${earlier.length} 轮`),
                      ...earlier.map((run, index) =>
                        h(
                          'div',
                          { key: `p${index}`, style: older },
                          h('span', { style: { ...tag, background: 'transparent', padding: 0 } }, timeOf(run)),
                          h(
                            'span',
                            null,
                            `${run.stepCount ?? stepsOf(run).length} 个工具 · ${stepsOf(run)
                              .slice(-2)
                              .map((step) => step.tag)
                              .join('/')}`,
                          ),
                        ),
                      ),
                    ]
                  : []),
              ),
            ]
          : []),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'workbuddy-toggle', order: 6 }, Toggle),
        );
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register({ name: 'conversation.input.dock', id: 'workbuddy-panel', order: 40 }, Panel),
        );
      },
    };
  },
});
