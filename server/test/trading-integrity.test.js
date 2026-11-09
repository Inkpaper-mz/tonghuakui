'use strict';
const assert = require('assert/strict');
const {Market} = require('../src/market');
const E = require('../src/engine'), P = require('../src/portfolio'), c = require('../src/config');
const sid = c.STOCKS[0].id;
function fixture() {
 const m = new Market({stocks:c.STOCKS,config:c}); m.tick();
 const st=m.S.get(sid); Object.assign(st,{price:10,rounded:10,limitUp:11,limitDown:9,flowBudget:10000,depth:{seq:m.seq,b:[[9.99,1000]],s:[[10.01,100],[10.03,900]]}}); m._invalidate(sid);
 const e=new E({market:m}); return {m,st,e};
}
{
 const {m,st}=fixture(); const volume=st.v;
 const preview=m.consumeLiquidity(sid,'buy',100,10.01,true); assert.equal(preview.filledQty,100); assert.equal(st.v,volume);
 m.consumeLiquidity(sid,'buy',100,10.01); assert.equal(st.v-volume,100);
 assert.equal(m.getQuote(sid).s[0][0],10.03);
 assert.equal(m.consumeLiquidity(sid,'buy',100,10.01).filledQty,0);
 assert.equal(st.v-volume,100);
}
{
 const {m,st,e}=fixture(); const seller=new P({id:'seller',market:m}),buyer=new P({id:'buyer',market:m});
 seller.positions.set(sid,{qty:900,avail:900,frozen:0,avgCost:10});e.registerPortfolio(seller);e.registerPortfolio(buyer);
 assert(e.placeOrder(seller,{stockId:sid,side:'sell',price:10.02,qty:900}).ok);
 const v=st.v;const r=e.placeOrder(buyer,{stockId:sid,side:'buy',price:10.03,qty:1000});
 assert.equal(r.order.filled,1000);assert.equal(st.v-v,1000);assert.equal(st.depth.s[1][1],900);
 assert.equal(seller.getPosition(sid).qty,0);assert.equal(buyer.getPosition(sid).qty,1000);
}
{
 const {m,e}=fixture();const p=new P({market:m});e.registerPortfolio(p);p.positions.set(sid,{qty:150,avail:150,frozen:0,avgCost:10});
 const r=e.placeOrder(p,{stockId:sid,side:'sell',price:10.5,qty:150});assert(r.ok);assert.equal(p.positions.get(sid).frozen,150);
 assert(e.cancelOrder(p,r.order.id).ok);assert.equal(p.getPosition(sid).avail,150);assert.equal(p.positions.get(sid).frozen,0);
}
{
 const p=new P({startCash:20000,market:{getQuote:()=>({p:10})}});p.applyTrade({stockId:sid,side:'buy',price:10,qty:1000});
 assert.equal(p.snapshot().positions[0].pnl,-5.1);assert.equal(p.computeAssets().pnl,-5.1);
 p.settleDay(1);p.applyTrade({stockId:sid,side:'sell',price:10,qty:1000});assert.equal(p.realizedPnl,p.computeAssets().pnl);
}
console.log('PASS: preview/commit, finite depth, mixed fills, odd-lot cancellation and exact cost accounting');
