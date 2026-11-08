import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withProfileTransaction } from '../src/lib/storage';
import { requireParentPin } from '../src/lib/parental-store';
import { readState,writeState,closeStateDatabases,stateDatabase } from '../src/state/database';
test('SQLite profile edits serialize with PIN checks and missing databases fail closed', async () => {
  const directory=await mkdtemp(join(tmpdir(),'homestream-storage-')); process.env.DATA_DIR=directory;
  try {
    writeState('profiles',[]);
    await Promise.all(Array.from({length:12},(_,id)=>withProfileTransaction(async()=>{
      const values=readState<{id:string;name:string}[]>('profiles',[]);
      await new Promise(resolve=>setTimeout(resolve,2));
      await withProfileTransaction(async()=>writeState('profiles',[...values,{id:String(id),name:'Viewer'}]));
    })));
    assert.equal(readState<unknown[]>('profiles',[]).length,12);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([
        Promise.all([requireParentPin('1234',true),withProfileTransaction(()=>requireParentPin('1234'))]),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PIN/profile lock inversion')),2000);}),
      ]);
    } finally {clearTimeout(timer);}
    closeStateDatabases(); await rm(join(directory,'homestream.sqlite'));
    assert.throws(()=>stateDatabase(),/missing/);
  } finally {closeStateDatabases();await rm(directory,{recursive:true,force:true});}
});
