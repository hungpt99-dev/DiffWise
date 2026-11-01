import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
const dist='/root/DiffWise/packages/webview/dist';
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml'};
const server=createServer(async(req,res)=>{const rel=(req.url??'/').split('?')[0];const f=normalize(join(dist,rel==='/'?'/index.html':rel));
 if(!f.startsWith(dist)){res.writeHead(403).end();return;}
 try{const b=await readFile(f);res.writeHead(200,{'Content-Type':MIME[extname(f)]??'application/octet-stream'}).end(b);}catch{if(!res.headersSent)res.writeHead(404).end();}});
await new Promise(r=>server.listen(4183,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:600,height:800}});
await page.goto('http://127.0.0.1:4183/',{waitUntil:'networkidle'});
await page.waitForSelector('.usage-card');
const m=await page.evaluate(()=>({docW:document.documentElement.scrollWidth,winW:window.innerWidth,hOverflow:document.documentElement.scrollWidth>window.innerWidth+1,
  clipped:[...document.querySelectorAll('.usage-value,.usage-label,.usage-table th,.usage-table td')].filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.textContent.slice(0,30))}));
console.log(JSON.stringify(m));
await page.screenshot({path:'/root/DiffWise/docs/screenshots/ui-overview-narrow600.png',fullPage:true});
await browser.close();await new Promise(r=>server.close(r));
