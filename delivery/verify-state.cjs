'use strict';
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');const crypto=require('node:crypto');const {DatabaseSync}=require('node:sqlite');
const [oldDirectory,newDirectory]=process.argv.slice(2);const file=path.join(newDirectory,'homestream.sqlite');
if(!fs.existsSync(file))throw Error('No migrated database was created');
const db=new DatabaseSync(file,{readOnly:true});
try{
 assert.equal(db.prepare('PRAGMA quick_check').get().quick_check,'ok');
 for(const [name,kind]of [['config.json','config'],['profiles.json','profiles'],['parental-controls.json','parental']]){
  const old=path.join(oldDirectory,name);if(!fs.existsSync(old))continue;
  const row=db.prepare('SELECT value FROM documents WHERE kind=?').get(kind);assert.ok(row,`Missing ${kind} state`);assert.deepEqual(JSON.parse(row.value),JSON.parse(fs.readFileSync(old,'utf8')),`${kind} state changed during import`);
 }
 const devices=path.join(oldDirectory,'devices.json');
 if(fs.existsSync(devices))for(const [token,device]of Object.entries(JSON.parse(fs.readFileSync(devices,'utf8')))){
  const hash=crypto.createHash('sha256').update(token).digest('hex');const row=db.prepare('SELECT value FROM devices WHERE credential_hash=?').get(hash);assert.ok(row,'A paired-device credential was lost');const {token:raw,...rest}=device;assert.deepEqual(JSON.parse(row.value),rest);
 }
 console.info('State integrity and legacy identity preservation verified');
}finally{db.close();}
