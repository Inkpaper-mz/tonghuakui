const assert=require('assert/strict');const P=require('../src/portfolio'),E=require('../src/engine'),c=require('../src/config');
const sid=c.STOCKS[0].id;
function fixture(cash=10005.1){let p=new P({startCash:cash}),e=new E();e.registerPortfolio(p);let o={id:'test',stockId:sid,side:'buy',qty:1000,filled:0,frozen:cash,price:10,status:'open',playerId:p.id,placedDay:0};p.freezeCash(cash);p.addOrder(o);e.orders.set(o.id,o);return {p,e,o}}
let {p,e,o}=fixture();for(let i=0;i<10;i++)assert(e._execute(p,o,10,100,1));assert.equal(p.feeTotal,5.1);assert.equal(p.cash+p.frozen,0);assert.equal(p.getPosition(sid).qty,1000);
({p,e,o}=fixture(100));let before=JSON.stringify(p.snapshot());assert.equal(e._execute(p,o,10,100,1),null);assert.equal(JSON.stringify(p.snapshot()),before);assert.equal(p.applyTrade({stockId:sid,side:'buy',qty:100,price:10,orderId:o.id}),null);
({p,e,o}=fixture());e.tick=500;e.lastDay=0;e._expireOrders();assert.equal(o.status,'open');e.lastDay=1;e._expireOrders();assert.equal(o.status,'canceled');assert.equal(p.cash,10005.1);
({p,e,o}=fixture());e.isTradingOpen=()=>false;assert.equal(e._execute(p,o,10,100,1),null);assert.equal(e.placeOrder(p,{stockId:sid,side:'buy',qty:100,price:10}).ok,false);e.isTradingOpen=()=>true;e.market={getState:()=>({halted:true})};assert.equal(e._execute(p,o,10,100,1),null);
console.log('PASS: cumulative fees, cash conservation, atomic rejection, day expiry, closed and halted execution guards');

