// id: H4
// title: pomodoro.startLast starts a counting session; stop ends it
const R = checks();
const p = st('pomodoro');
act('pomodoro.startLast');
await sleep(1500);
R.t(p.active, 'session active');
const c1 = p.countdown; await sleep(1200); const c2 = p.countdown;
R.t(c1 !== c2, 'countdown runs (' + c1 + ' -> ' + c2 + ')');
p.stop();
R.t(!p.active, 'stopped');
return R.done();
