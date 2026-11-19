import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [path, mode = 'normal'] = process.argv.slice(2);
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { threads: {}, turns: 0 };
const save = () => writeFileSync(path, JSON.stringify(state));
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const result = (id, value) => send({ id, result: value });
const notification = (method, params) => send({ method, params });
let waiting;
function complete(threadId, turn, reply = 'hello') {
  const item = { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify({ reply }) };
  turn.items.push(item);
  turn.status = 'completed';
  save();
  notification('item/completed', { threadId, turnId: turn.id, item });
  notification('turn/completed', { threadId, turn });
}
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const p = message.params ?? {};
  if (!message.method) {
    if (waiting && message.id === 'tool-call') {
      const current = waiting;
      waiting = null;
      complete(current.threadId, current.turn, message.result.contentItems[0].text);
    }
    return;
  }
  switch (message.method) {
    case 'initialize': result(message.id, {}); break;
    case 'initialized': break;
    case 'thread/start': {
      const id = 'thread-' + (Object.keys(state.threads).length + 1);
      state.threads[id] = { turns: [], options: p };
      save();
      result(message.id, { thread: { id } });
      break;
    }
    case 'thread/resume': result(message.id, { thread: { id: p.threadId } }); break;
    case 'thread/turns/list': {
      if (mode === 'paginated' && !p.cursor) {
        result(message.id, { data: [], nextCursor: 'older' });
      } else result(message.id, { data: [...state.threads[p.threadId].turns].reverse(), nextCursor: null });
      break;
    }
    case 'thread/read': result(message.id, { thread: state.threads[p.threadId] }); break;
    case 'turn/start': {
      state.turns += 1;
      const turn = { id: 'turn-' + state.turns, status: 'inProgress', items: [{ type: 'userMessage', content: p.input }] };
      state.threads[p.threadId].turns.push(turn);
      save();
      if (mode === 'lost-completed') {
        turn.status = 'completed';
        turn.items.push({ type: 'agentMessage', text: JSON.stringify({ reply: 'saved before disconnect' }) });
        save(); process.exit(0);
      }
      if (mode === 'lost-running') process.exit(0);
      notification('turn/started', { threadId: p.threadId, turn });
      result(message.id, { turn });
      if (mode === 'interrupt') break;
      if (mode === 'tool' || mode === 'stale-tool') {
        waiting = { threadId: p.threadId, turn };
        send({ id: 'tool-call', method: 'item/tool/call', params: { threadId: p.threadId, turnId: mode === 'stale-tool' ? 'previous-turn' : turn.id, tool: 'music_test', arguments: { value: 42 } } });
        break;
      }
      notification('item/completed', { threadId: p.threadId, turnId: 'unrelated', item: { type: 'agentMessage', text: 'wrong turn' } });
      notification('turn/completed', { threadId: p.threadId, turn: { id: 'unrelated', status: 'completed', items: [] } });
      complete(p.threadId, turn);
      break;
    }
    case 'turn/interrupt': {
      const turn = state.threads[p.threadId].turns.find(turn => turn.id === p.turnId);
      turn.status = 'interrupted'; save(); result(message.id, {});
      notification('turn/completed', { threadId: p.threadId, turn });
      break;
    }
    default: send({ id: message.id, error: { code: -32601, message: 'unknown method' } });
  }
});
