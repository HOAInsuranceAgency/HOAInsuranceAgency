const blocked = async () => { throw new Error('Storage is disabled in the fictional preview.'); };
export const getUrl = blocked, remove = blocked, downloadData = blocked, list = blocked;
export const uploadData = () => ({ result: blocked() });
