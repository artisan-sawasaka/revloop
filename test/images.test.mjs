import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,symlink,unlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {snapshot} from '../dist/snapshot.js';
import {start,review} from '../dist/engine.js';
import {inspectImage,storeImages,loadImages,claudeImageInput,imageCopyPath} from '../dist/images.js';
import {providerArgs,decodeResult} from '../dist/providers.js';
import {parseReview,hasVisualCoverage} from '../dist/types.js';
import {spawnSync} from 'node:child_process';
const sessionId='11111111-2222-3333-4444-555555555555';
const pass={verdict:'PASS',summary:'ok',findings:[]};
const visual=(files=['panel.png'])=>({status:'REVIEWED',observations:files.map(file=>({file,observation:'A solid blue panel is visible.'}))});
const png=()=>sharp({create:{width:16,height:16,channels:3,background:'#0000ff'}}).png().toBuffer();
async function fixture(){const root=await mkdtemp(path.join(os.tmpdir(),'revloop-image-'));await writeFile(path.join(root,'panel.png'),await png());return root;}

test('PNG/JPEG/WebP are attached as bytes and fingerprinted, never decoded as text',async()=>{
  const root=await fixture();
  for(const format of ['jpeg','webp'])await writeFile(path.join(root,'panel.'+format),await sharp(await png()).toFormat(format).toBuffer());
  const snap=await snapshot(root,['panel.png','panel.jpeg','panel.webp'],'Inspect the panels');
  assert.equal(snap.images.length,3);assert.ok(snap.images.every(i=>i.data.length>0));
  const files=JSON.parse(snap.input).files;assert.ok(files.every(f=>f.kind==='image'&&f.content===null&&f.image.width===16));
  assert.ok(!snap.input.includes('base64'));
  await writeFile(path.join(root,'panel.png'),await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png().toBuffer());
  assert.notEqual((await snapshot(root,['panel.png','panel.jpeg','panel.webp'],'Inspect the panels')).fingerprint,snap.fingerprint);
});
test('corrupt, mislabeled, over-dimensioned images and path escape fail closed',async t=>{
  const root=await fixture();await writeFile(path.join(root,'bad.png'),'not an image');
  await assert.rejects(snapshot(root,['bad.png'],'inspect'));
  await assert.rejects(inspectImage('wrong.jpg',await png(),1),/Invalid/);
  await assert.rejects(inspectImage('truncated.png',(await png()).subarray(0,50),1));
  const huge=await sharp({create:{width:4097,height:1,channels:3,background:'#ffffff'}}).png().toBuffer();
  await assert.rejects(inspectImage('wide.png',huge,1),/oversized/);
  await assert.rejects(inspectImage('big.png',Buffer.alloc(3_500_001),1),/oversized/);
  await assert.rejects(start(root,{source:'codex',title:'no pixels',context:'inspect',files:['x.txt'],visual:true}));
  await writeFile(path.join(root,'x.txt'),'text');
  await assert.rejects(start(root,{source:'codex',title:'no pixels',context:'inspect',files:['x.txt'],visual:true}),/requires PNG/);
  const outside=await fixture();try{await symlink(outside,path.join(root,'linked'),'junction');}catch(e){if(e.code==='EPERM'){t.skip();return;}throw e;}
  await assert.rejects(snapshot(root,['linked/panel.png'],'inspect'),/Symlink/);
});
test('snapshot refuses excess image count instead of dropping images',async()=>{
  const root=await fixture(),files=[];for(let i=0;i<9;i++){const file=`${i}.png`;await writeFile(path.join(root,file),await png());files.push(file);}
  await assert.rejects(snapshot(root,files,'inspect'),/Too many/);
});

test('deleting a tracked image cannot silently reduce visual scope',async()=>{
  const root=await fixture();for(const args of [['init'],['add','panel.png']])assert.equal(spawnSync('git',args,{cwd:root,windowsHide:true}).status,0);
  await unlink(path.join(root,'panel.png'));
  await assert.rejects(snapshot(root,['panel.png'],'inspect'),/image is missing/);
});
test('both initial and resumed requests attach all images without enabling tools',async()=>{
  const root=await fixture(),snap=await snapshot(root,['panel.png'],'inspect'),round=path.join(root,'round');await mkdir(round);await storeImages(round,snap.images);
  const images=await loadImages(round,JSON.parse(snap.input).files);
  for(const reviewerSession of [undefined,sessionId])for(const reviewer of ['codex','claude']){
    const s={reviewer,reviewerSession,title:'visual'},args=providerArgs(s,path.join(round,'schema.json'),images);
    if(reviewer==='codex'){assert.equal(args[args.indexOf('--image')+1],imageCopyPath(round,images[0].image));assert.ok(args.includes('read-only'));}
    else{assert.equal(args[args.indexOf('--input-format')+1],'stream-json');assert.equal(args[args.indexOf('--tools')+1],'');assert.ok(args.includes('--restricted'));}
    if(reviewerSession)assert.ok(args.includes(sessionId));
  }
  const request=JSON.parse(claudeImageInput('inspect',images,sessionId));assert.equal(request.session_id,sessionId);
  const block=request.message.content.find(b=>b.type==='image');assert.equal(block.source.media_type,'image/png');assert.deepEqual(Buffer.from(block.source.data,'base64'),await png());
  await writeFile(imageCopyPath(round,images[0].image),'tampered');await assert.rejects(loadImages(round,JSON.parse(snap.input).files),/modified/);
});
test('missing visual schema and incomplete observations cannot count as a visual pass',async()=>{
  assert.throws(()=>parseReview(pass,true),/Invalid/);
  const complete={...pass,visual:visual()};assert.deepEqual(parseReview(complete,true),complete);
  assert.equal(hasVisualCoverage(complete,['panel.png']),true);assert.equal(hasVisualCoverage(complete,['panel.png','other.png']),false);
  assert.equal(hasVisualCoverage({...pass,visual:visual(['panel.png','panel.png'])},['panel.png','other.png']),false);
  for(const returned of [pass,{...pass,visual:{status:'NOT_RUN',observations:[]}}]){
    const root=await fixture(),s=await start(root,{source:'claude',context:'appearance',title:'visual',files:['panel.png']});
    const result=await review(root,s.id,async()=>({sessionId,review:returned}));
    assert.equal(result.status,'BLOCKED');assert.equal(result.rounds[0].visualReview.status,'NOT_RUN');
  }
});
test('image replacement re-reviews on the same session, and source/copy tampering rejects PASS',async()=>{
  const root=await fixture(),s=await start(root,{source:'codex',context:'appearance',title:'visual',files:['panel.png']});
  const first={verdict:'FAIL',summary:'wrong color',findings:[{severity:'P2',file:'panel.png',line:0,message:'wrong color',fix:'use red'}],visual:visual()};
  assert.equal((await review(root,s.id,async()=>({sessionId,review:first}))).status,'NEEDS_FIX');
  await writeFile(path.join(root,'panel.png'),await sharp({create:{width:16,height:16,channels:3,background:'#ff0000'}}).png().toBuffer());
  const second=await review(root,s.id,async st=>{assert.equal(st.reviewerSession,sessionId);return {sessionId,review:{...pass,visual:{status:'REVIEWED',observations:[{file:'panel.png',observation:'Red panel visible.'}]}}};});
  assert.equal(second.status,'PASS');assert.equal(second.rounds[1].visualReview.status,'REVIEWED');assert.notEqual(second.rounds[0].fingerprint,second.rounds[1].fingerprint);
  for(const target of ['source','copy']){
    const r=await fixture(),run=await start(r,{source:'codex',context:'appearance',title:'tamper',files:['panel.png']});
    const result=await review(r,run.id,async(st,dir)=>{await writeFile(target==='copy'?path.join(dir,'images','1.png'):path.join(r,'panel.png'),await sharp({create:{width:16,height:16,channels:3,background:'red'}}).png().toBuffer());return {sessionId,review:{...pass,visual:visual()}};});
    assert.equal(result.status,'ERROR');assert.equal(result.rounds[0].visualReview.status,'NOT_RUN');
  }
});
test('image-mode Claude result decoder requires its visual evidence',()=>{
  const raw={code:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sessionId,structured_output:{...pass,visual:visual()}})};
  assert.equal(decodeResult('claude',raw,undefined,true).review.visual.status,'REVIEWED');
  const streamed={...raw,stdout:JSON.stringify({type:'system',subtype:'init'})+'\n'+raw.stdout+'\n'};
  assert.equal(decodeResult('claude',streamed,undefined,true).review.visual.status,'REVIEWED');
  assert.throws(()=>decodeResult('claude',{...raw,stdout:raw.stdout+'\n'+raw.stdout},undefined,true),/exactly one/);
});

test('CLI visual flag requires images and text-only PASS still reports visual NOT_RUN',async()=>{
  const root=await fixture();await writeFile(path.join(root,'context.txt'),'Inspect appearance');
  const cli=path.resolve('dist/cli.js');
  const call=args=>spawnSync(process.execPath,[cli,...args],{cwd:root,encoding:'utf8',windowsHide:true});
  const image=call(['start','--source','codex','--title','visual','--context','context.txt','--file','panel.png','--visual']);
  assert.equal(image.status,0,image.stderr);assert.equal(JSON.parse(image.stdout).visualRequired,true);
  const bad=call(['start','--source','codex','--title','missing','--context','context.txt','--file','context.txt','--visual']);assert.equal(bad.status,1);
  const text=await start(root,{source:'codex',context:'text only',title:'text',files:['context.txt']});await review(root,text.id,async()=>({sessionId,review:pass}));
  const result=JSON.parse(call(['status','--run',text.id]).stdout);assert.equal(result.status,'PASS');assert.equal(result.visualReview.status,'NOT_RUN');
});

test('PASS plus P3 findings preserves completed visual review and returns NEEDS_FIX',async()=>{
  const root=await fixture(),s=await start(root,{source:'codex',context:'image and evidence',title:'verdict contradiction',files:['panel.png']});
  const payload={...pass,findings:[{severity:'P3',file:'panel.png',line:0,message:'Required evidence is missing',fix:'Record the missing evidence'}],visual:visual()};
  const raw={code:0,stderr:'',stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:sessionId,structured_output:payload})};
  const result=await review(root,s.id,async()=>decodeResult('claude',raw,undefined,true));
  assert.equal(result.status,'NEEDS_FIX');assert.equal(result.rounds[0].visualReview.status,'REVIEWED');assert.equal(result.rounds[0].review.verdict,'PASS');assert.equal(result.rounds[0].decision.effectiveVerdict,'FAIL');
});
