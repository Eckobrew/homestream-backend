let revision=0;
export const requestRevision=()=>revision;
export const invalidateRequested=()=>{revision++;};
