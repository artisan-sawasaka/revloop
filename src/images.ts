import sharp from 'sharp';
import path from 'node:path';
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {safeDir} from './storage.js';

export const imageLimits={count:8,perImageBytes:3_500_000,totalBytes:16_000_000,pixels:16_000_000,dimension:4096};
const extensions:Record<string,string>={'.png':'png','.jpg':'jpeg','.jpeg':'jpeg','.webp':'webp'};
export interface ImageInfo {index:number;mime:'image/png'|'image/jpeg'|'image/webp';width:number;height:number;bytes:number}
export interface SnapshotImage {path:string;sha256:string;image:ImageInfo;data:Buffer}
export const isImagePath=(file:string)=>path.extname(file).toLowerCase() in extensions;
const digest=(data:Buffer)=>createHash('sha256').update(data).digest('hex');
export async function inspectImage(file:string,data:Buffer,index:number):Promise<SnapshotImage> {
  if(!isImagePath(file)||data.length>imageLimits.perImageBytes)throw Error(`Unsupported or oversized image: ${file}`);
  const format=extensions[path.extname(file).toLowerCase()];
  const signatureOK=format==='png'?data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):format==='jpeg'?data[0]===255&&data[1]===216&&data[2]===255:data.toString('ascii',0,4)==='RIFF'&&data.toString('ascii',8,12)==='WEBP';
  if(!signatureOK)throw Error(`Invalid image signature: ${file}`);
  const decoder=sharp(data,{limitInputPixels:imageLimits.pixels,failOn:'warning'});
  const metadata=await decoder.metadata();
  if(metadata.format==='png')for(let offset=8;offset+12<=data.length;){
    const length=data.readUInt32BE(offset);if(data.toString('ascii',offset+4,offset+8)==='acTL')throw Error(`Animated PNG is unsupported: ${file}`);
    offset+=12+length;
  }
  if(metadata.format!==extensions[path.extname(file).toLowerCase()]||!metadata.width||!metadata.height||metadata.width>imageLimits.dimension||metadata.height>imageLimits.dimension||(metadata.pages??1)!==1)throw Error(`Invalid, animated or oversized image: ${file}`);
  await decoder.stats(); // Decode pixels: a valid header alone is insufficient.
  return {path:file,sha256:digest(data),data,image:{index,mime:`image/${metadata.format}` as ImageInfo['mime'],width:metadata.width,height:metadata.height,bytes:data.length}};
}
export const imageCopyPath=(roundDir:string,info:ImageInfo)=>path.join(roundDir,'images',`${info.index}.${info.mime==='image/jpeg'?'jpg':info.mime==='image/png'?'png':'webp'}`);
export async function storeImages(roundDir:string,images:SnapshotImage[]):Promise<void> {
  if(!images.length)return;await safeDir(path.join(roundDir,'images'));
  for(const item of images)await writeFile(imageCopyPath(roundDir,item.image),item.data,{flag:'wx'});
}
export async function loadImages(roundDir:string,entries:unknown):Promise<SnapshotImage[]> {
  if(!Array.isArray(entries))throw Error('Invalid snapshot files');
  const images:SnapshotImage[]=[];let bytes=0;
  for(const entry of entries.filter(e=>e?.kind==='image')) {
    const info=entry.image as ImageInfo;
    if(!info||info.index!==images.length+1||!['image/png','image/jpeg','image/webp'].includes(info.mime)||typeof entry.path!=='string'||typeof entry.sha256!=='string')throw Error('Invalid image manifest');
    const data=await readFile(imageCopyPath(roundDir,info));bytes+=data.length;
    if(data.length>imageLimits.perImageBytes||bytes>imageLimits.totalBytes||images.length>=imageLimits.count||digest(data)!==entry.sha256)throw Error('Reviewer image modified or oversized');
    images.push({path:entry.path,sha256:entry.sha256,image:info,data});
  }
  return images;
}
export function claudeImageInput(prompt:string,images:SnapshotImage[],sessionId?:string):string {
  return JSON.stringify({type:'user',session_id:sessionId??'',parent_tool_use_id:null,message:{role:'user',content:[{type:'text',text:prompt},...images.flatMap(i=>[{type:'text',text:`Attached image ${i.image.index}: ${JSON.stringify(i.path)}`},{type:'image',source:{type:'base64',media_type:i.image.mime,data:i.data.toString('base64')}}])]}})+'\n';
}
