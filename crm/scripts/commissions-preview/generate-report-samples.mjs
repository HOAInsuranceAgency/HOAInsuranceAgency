/**
 * Render fictional review PDFs through the production report generators.
 * No AWS SDK, network access, mail, storage writes or payroll approval actions.
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { zipSync, strToU8 } = require('fflate');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const stamp = '2026-11-06T16:00:00Z';

export async function generateReportSamples(outputDirectory = join(here, 'review-pdfs')) {
  // The launcher supplies a task-local output directory; generated browser assets live in the catalog.
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(here, '.report-render-'));
  const documents = [];
  const sourcePaths = ['../../amplify/functions/commissions/reports.ts', '../../amplify/functions/commissions/departure-report.ts', '../../amplify/functions/commissions/report-layout.ts', '../../amplify/functions/commissions/report-brand.ts'];
  const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async p => [p, sha(await readFile(resolve(here, p)))])));
  async function fixture(scenario) {
    const out = join(scratch, scenario + '.cjs');
    await build({
      stdin: {
        contents: 'export {data, payrollWorkspace, departure} from "./fixtures";\n' +
          'export {commissionReportFiles} from "../../amplify/functions/commissions/reports";\n' +
          'export {departureStatement, departureReportFile} from "../../amplify/functions/commissions/departure-report";\n' +
          'export {buildPayrollApproval, defaultPayrollSettings, suggestPayrollDates} from "../../../shared/commissionPayroll";\n' +
          'export {departureWorklist} from "../../../shared/commissionExceptions";',
        resolveDir: here, sourcefile: 'report-sample-entry.ts', loader: 'ts'
      },
      outfile: out, bundle: true, platform: 'node', format: 'cjs', packages: 'external',
      define: { location: JSON.stringify({protocol:'http:',search:'?scenario=' + scenario}) },
      logLevel: 'silent'
    });
    return require(out);
  }
  async function addPayroll(group, label, scenario, cycle, batches, render) {
    const originals = await render(cycle, batches);
    const files = await render(cycle, batches, undefined, {isTest:true});
    for (const [index,file] of files.entries()) {
      const batch = index ? batches.find(b=>b.id === cycle.batchIds[index-1]) : undefined;
      const content = Buffer.from(file.content);
      const filename = group + '_' + file.filename;
      const item = {id:group + ':' + (batch?.producerId || 'summary'),group,label,scenario,
        cycleId:cycle.id,revision:cycle.revision,documentId:batch?.id || 'summary',
        audience:batch?'EMPLOYEE':'HR',producerId:batch?.producerId || '',
        title:batch?batch.producerName + ' earnings':'HR payroll summary',
        totalCents:batch?.totalCents ?? cycle.totalCents,filename,contentType:'application/pdf',
        originalSha256:sha(originals[index].content),sha256:sha(content),content:content.toString('base64')};
      await writeFile(join(output,filename),content);
      documents.push(item);
    }
  }
  try {
    const exceptional = await fixture('exceptions');
    const current = structuredClone(exceptional.payrollWorkspace.cycles[1]);
    const currentBatches = structuredClone(exceptional.payrollWorkspace.batches);
    await addPayroll('P03_Current_v2','Current November report · revision 2','exceptions',current,currentBatches,exceptional.commissionReportFiles);
    const previous = {...current,revision:1,replacesRevision:undefined,correctionReason:undefined};
    const previousBatches = currentBatches.map(b=>({...b,id:b.id.replace(':2:',':1:'),cycleRevision:1,payments:[]}));
    previous.batchIds = previousBatches.map(b=>b.id);
    await addPayroll('P03_Historical_v1','Historical November report · revision 1','exceptions',previous,previousBatches,exceptional.commissionReportFiles);

    const shared = await fixture('shared');
    const approved = shared.buildPayrollApproval(
      structuredClone(shared.payrollWorkspace.cycles[0]), structuredClone(shared.data.policies), [],
      shared.defaultPayrollSettings('owner@example.test'), 'Example Owner', '2026-10-24T14:00:00Z',
      structuredClone(shared.data.earnings ?? [])
    );
    await addPayroll('Shared','Shared commission sample · October','shared',approved.cycle,approved.batches,shared.commissionReportFiles);

    const dates = shared.suggestPayrollDates('2026-11');
    const offCycle = {...dates,id:'2026-11-OFF-1234abcd',cycleType:'OFF_CYCLE',reason:'Fictional late receipt review',
      cutoff:'2026-11-01',reviewOn:'2026-11-02',hrDueOn:'2026-11-02',processingOn:'2026-11-02',payDate:'2026-11-05',
      version:1,revision:1,status:'APPROVED',batchIds:['sample-off-cycle-jordan'],totalCents:12000,
      approvedBy:'Example Owner',approvedAt:'2026-11-02T14:00:00Z'};
    const offBatch = {id:'sample-off-cycle-jordan',version:1,cycleId:offCycle.id,cycleRevision:1,producerId:'jordan',
      producerName:'Jordan Hayes',cutoff:offCycle.cutoff,payDate:offCycle.payDate,status:'APPROVED',totalCents:12000,
      lines:[{policyId:'sample-late',entryId:'sample-late-receipt',accountName:'Fictional Lakeside HOA',policyNumber:'QA-L001',
        receivedOn:'2026-10-24',transaction:'NEW',agencyCents:75000,producerBps:1600,amountCents:12000}]};
    await addPayroll('Off_Cycle','Off-cycle sample · late receipt','off-cycle',offCycle,[offBatch],shared.commissionReportFiles);

    const adjusted = {...current,id:'2026-12',...shared.suggestPayrollDates('2026-12'),revision:1,replacesRevision:undefined,
      correctionReason:undefined,totalCents:34500,batchIds:['sample-adjustment-avery'],approvedAt:'2026-12-19T14:00:00Z'};
    const adjustedBatch = {...currentBatches[0],id:'sample-adjustment-avery',cycleId:adjusted.id,cycleRevision:1,
      cutoff:adjusted.cutoff,payDate:adjusted.payDate,totalCents:34500,payments:[],
      lines:[...currentBatches[0].lines,{policyId:'sample-adjustment-policy',entryId:'sample-additional-25',
        earningId:'sample-adjustment-earning',accountName:'Fictional compensation adjustment',policyNumber:'QA-ADJ001',
        receivedOn:'2026-12-18',transaction:'NEW',source:'ADJUSTMENT',agencyCents:0,producerBps:0,amountCents:2500}]};
    await addPayroll('Adjustment','Adjustment sample · additional $25','adjustment',adjusted,[adjustedBatch],shared.commissionReportFiles);

    const departureCase = structuredClone(shared.departure);
    const worklist = shared.departureWorklist(departureCase,shared.data.policies,shared.data.earnings ?? [],shared.data.batches);
    const departureReport = await shared.departureStatement(departureCase,worklist,stamp);
    const original = Buffer.from(shared.departureReportFile(departureReport).content,'base64');
    const testDeparture = await shared.departureStatement(departureCase,worklist,stamp,{isTest:true});
    const content = Buffer.from(shared.departureReportFile(testDeparture).content,'base64');
    const departureFile = 'Departure_' + departureReport.filename;
    await writeFile(join(output,departureFile),content);
    documents.push({id:'Departure:producer',group:'Departure',label:'Departure review · held earnings',scenario:'shared',
      cycleId:'',revision:departureCase.version,documentId:'departure',audience:'HR',producerId:'producer',
      title:'Avery Brooks departure review',totalCents:null,filename:departureFile,contentType:'application/pdf',
      originalSha256:sha(original),sha256:sha(content),content:content.toString('base64')});

    const catalog = {generatedAt:stamp,sourceHashes,documents};
    await writeFile(join(here,'report-samples.generated.json'),JSON.stringify(catalog));
    await writeFile(join(output,'manifest.json'),JSON.stringify({...catalog,documents:documents.map(({content,...d})=>d)},null,2));
    const explanation = [
      '# Commission PDF review samples','',
      'All PDFs contain fictional data and a TEST DATA - DO NOT PAY watermark.',
      'The actual CRM commissionReportFiles and departureStatement generators render these layouts with their explicit test-mode banner and watermark. Production rendering defaults to no watermark.',
      'Current/historical November PDFs show the approved $320. The sample $120 payment and $200 balance are tracked in the CRM, not by rewriting the approved PDF.',
      'Shared examples are separate simulated snapshots ($504 total: Avery $440, Jordan $64). Off-cycle ($120), additional adjustment ($345), and departure examples are independent fixtures, not cumulative payroll.',
      'Historical v1 is reconstructed from the fictional fixture for visual review, not fetched from a real archive. Original-template hashes and watermarked-file hashes are recorded separately in manifest.json.',
      'Departure review shows held earnings requiring decisions. Expected carrier balances are agency forecasts, not employee amounts payable.',
      '',
      ...documents.map(d=>'- '+d.filename+' — '+d.label+'; '+d.title+(d.totalCents===null?'':'; $'+(d.totalCents/100).toFixed(2)))
    ].join('\n');
    await writeFile(join(output,'README.md'),explanation);
    const zipEntries = Object.fromEntries(await Promise.all(documents.map(async d=>[d.filename,new Uint8Array(await readFile(join(output,d.filename)))])));
    zipEntries['README.md']=strToU8(explanation);
    zipEntries['manifest.json']=new Uint8Array(await readFile(join(output,'manifest.json')));
    const zipPath=join(dirname(output),'HOA_Commission_PDF_Review.zip');
    await writeFile(zipPath,zipSync(zipEntries));
    console.log(JSON.stringify({output,zipPath,documents:documents.map(({content,...d})=>d)}));
    return {output,zipPath,documents};
  } finally {
    const checked = resolve(scratch);
    if (dirname(checked)!==resolve(here) || !checked.split(/[\\/]/).pop().startsWith('.report-render-')) throw new Error('Unexpected render scratch directory');
    await rm(checked,{recursive:true,force:true});
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2] || join(here,'review-pdfs');
  await generateReportSamples(output);
}
