import { PDFDocument, StandardFonts, rgb, degrees, type PDFFont, type PDFPage, type PDFImage, type RGB } from 'pdf-lib';
import { commissionLogo } from './report-brand';

export interface ReportRenderOptions { isTest?: boolean }
export type Tone = 'covered' | 'attention' | 'uncovered' | 'notice' | 'neutral';
export const palette = {
  navy: rgb(27 / 255, 54 / 255, 88 / 255), ink: rgb(.06, .10, .17),
  muted: rgb(.32, .40, .51), gold: rgb(.84, .66, .27),
  rule: rgb(.83, .87, .92), light: rgb(.968, .976, .985), white: rgb(1, 1, 1),
};
const tones: Record<Tone, { ink: RGB; fill: RGB }> = {
  covered: { ink: rgb(0, .43, .16), fill: rgb(.95, .99, .96) },
  attention: { ink: rgb(.65, .43, .04), fill: rgb(1, .985, .95) },
  uncovered: { ink: rgb(.78, .05, .06), fill: rgb(1, .96, .96) },
  notice: { ink: palette.navy, fill: palette.light },
  neutral: { ink: palette.muted, fill: palette.light },
};
export const reportMoney = (cents: number) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function reportDate(value?: string) {
  if (!value) return { date: 'Not recorded', weekday: '' };
  const at = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(at.getTime())) throw new Error('A report contains an invalid calendar date.');
  return {
    date: at.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }),
    weekday: at.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long' }),
  };
}
export function reportTimestamp(value?: string) {
  if (!value) return { iso: 'Not recorded', date: 'Not recorded', time: '' };
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) throw new Error('A report contains an invalid approval timestamp.');
  return {
    iso: at.toISOString(),
    date: at.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }),
    time: at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' ET',
  };
}
export function statusTone(value: string): Tone {
  if (['APPROVED', 'PAID', 'PAY', 'CONTINUE'].includes(value)) return 'covered';
  if (['REVIEW', 'PENDING', 'DRAFT'].includes(value)) return 'attention';
  if (['EXCLUDE', 'EXCLUDED', 'DENIED'].includes(value)) return 'uncovered';
  return 'neutral';
}
export interface ReportCell { text: string; bold?: boolean; align?: 'left' | 'right'; tone?: Tone; progress?: number }
export interface ReportFact { label: string; value: string; detail?: string; tone?: Tone; strong?: boolean }

/** Self-contained Letter layout. No network fonts, browser process, or mutable branding at delivery time. */
export class CommissionPdf {
  readonly width = 524;
  readonly left = 44;
  readonly bottom = 718;
  page!: PDFPage;
  y = 0;
  private heading = '';
  private meta = '';
  private footerText = '';
  private constructor(
    readonly doc: PDFDocument,
    private regular: PDFFont,
    private bold: PDFFont,
    private logo: PDFImage,
    private copy: string,
    private options: ReportRenderOptions,
  ) {}
  static async create(title: string, at: string, copy: string, options: ReportRenderOptions = {}) {
    const doc = await PDFDocument.create();
    const date = new Date(at);
    if (!Number.isFinite(date.getTime())) throw new Error('A report contains an invalid snapshot timestamp.');
    doc.setCreationDate(date); doc.setModificationDate(date);
    doc.setProducer('HOA Insurance Agency CRM'); doc.setCreator('HOA Insurance Agency CRM'); doc.setTitle(title);
    if (options.isTest) doc.setSubject('Fictional review copy. TEST DATA - DO NOT PAY.');
    return new CommissionPdf(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold),
      await doc.embedPng(commissionLogo), copy, options);
  }
  wrap(value: string, size = 10, width = this.width, bold = false): string[] {
    const font = bold ? this.bold : this.regular;
    const text = String(value).replace(/[\r\n\t]+/g, ' ').normalize('NFC');
    try {
      const lines: string[] = []; let line = '';
      for (const word of text.split(/\s+/)) {
        const candidate = line ? line + ' ' + word : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) { line = candidate; continue; }
        if (line) { lines.push(line); line = ''; }
        for (const char of word) {
          if (font.widthOfTextAtSize(line + char, size) > width && line) { lines.push(line); line = ''; }
          line += char;
        }
      }
      lines.push(line); return lines;
    } catch { throw new Error('A report name or policy contains a character unsupported by the PDF font. Review the source text before delivery.'); }
  }
  text(value: string, top: number, x = this.left, size = 10, bold = false, color = palette.ink, width = this.width, align: 'left' | 'right' = 'left') {
    const font = bold ? this.bold : this.regular;
    const lines = this.wrap(value, size, width, bold);
    lines.forEach((line, i) => this.page.drawText(line, {
      x: align === 'right' ? x + width - font.widthOfTextAtSize(line, size) : x,
      y: 792 - top - size - i * (size + 4), size, font, color,
    }));
    return lines.length * (size + 4);
  }
  box(x: number, top: number, width: number, height: number, fill = palette.white, border = palette.rule, radius = 6) {
    // SVG coordinates run downward; pdf-lib handles the page-space transform.
    const r = Math.min(radius, width / 2, height / 2);
    this.page.drawSvgPath(`M ${r} 0 H ${width-r} Q ${width} 0 ${width} ${r} V ${height-r} Q ${width} ${height} ${width-r} ${height} H ${r} Q 0 ${height} 0 ${height-r} V ${r} Q 0 0 ${r} 0 Z`,
      { x, y: 792-top, color: fill, borderColor: border, borderWidth: .65 });
  }
  line(top: number, x = this.left, width = this.width, color = palette.rule, thickness = .6) {
    this.page.drawLine({ start: { x, y: 792-top }, end: { x: x+width, y: 792-top }, thickness, color });
  }
  badge(label: string, x: number, top: number, tone: Tone = 'notice') {
    const size = 7, width = this.bold.widthOfTextAtSize(label, size) + 16;
    const t = tones[tone];
    this.box(x, top, width, 16, t.fill, t.ink, 8);
    this.text(label, top+3, x+8, size, true, t.ink, width-16);
    return width;
  }
  private addPage(continued: boolean) {
    this.page = this.doc.addPage([612, 792]);
    if (this.options.isTest) {
      this.page.drawText('TEST DATA', { x: 100, y: 330, size: 74, font: this.bold, color: rgb(.75,.2,.2), opacity: .045, rotate: degrees(32) });
      this.box(44, 32, 524, 20, rgb(1,.965,.965), rgb(1,.74,.74), 1);
      this.text('TEST DATA — DO NOT PAY', 37, 53, 7, true, tones.uncovered.ink, 240);
      this.text('Generated from test records for visual review', 37, 295, 6.8, false, tones.uncovered.ink, 264, 'right');
    }
    const top = this.options.isTest ? 65 : 42;
    this.page.drawImage(this.logo, { x:44, y:792-top-33, width:166, height:33 });
    this.text(this.copy.toUpperCase(), top, 342, 7.2, true, rgb(.65,.43,.04), 226, 'right');
    this.text('420 Lakeside Ave, Suite 202', top+14, 342, 7.6, false, palette.muted, 226, 'right');
    this.text('Marlborough, MA 01752', top+25, 342, 7.6, false, palette.muted, 226, 'right');
    this.line(top+44); this.line(top+44,44,65,palette.gold,2);
    this.y = top+60;
    if (continued) {
      this.text(this.meta + ' · CONTINUED', this.y, 44, 7, true, rgb(.65,.43,.04));
      this.y += 17;
      this.y += this.text(this.heading, this.y, 44, 16, true, palette.navy);
      this.y += 10;
    }
  }
  start(meta: string, title: string, subtitle: string, badges: { label: string; tone: Tone }[] = []) {
    this.meta = meta; this.heading = title;
    this.addPage(false);
    // Keep metadata and badges on separate lines when identifiers are long.
    const badgeWidth = badges.reduce((sum,b)=>sum + this.bold.widthOfTextAtSize(b.label,7)+22,0);
    const metaHeight = this.text(meta,this.y,44,7.2,true,rgb(.65,.43,.04),Math.max(180,524-badgeWidth-10));
    if (badges.length) {
      let x = 568-badgeWidth+6;
      for (const badge of badges) x += this.badge(badge.label,x,this.y-2,badge.tone)+6;
    }
    this.y += Math.max(18,metaHeight+7);
    this.y += this.text(title,this.y,44,21,true,palette.navy);
    this.y += 4;
    this.y += this.text(subtitle,this.y,44,10,false,palette.navy);
    this.y += 16;
  }
  ensure(height: number) { if (this.y + height > this.bottom) this.addPage(true); }
  paragraph(value: string, size = 9, bold = false, color = palette.muted) {
    for (const line of this.wrap(value,size,this.width,bold)) {
      this.ensure(size+4);
      this.text(line,this.y,44,size,bold,color); this.y += size+4;
    }
    this.y += 6;
  }
  callout(title: string, detail = '', tone: Tone = 'notice') {
    const titleHeight = this.wrap(title,9.5,492,true).length*13.5;
    const detailHeight = detail ? this.wrap(detail,8.7,492).length*12.7+4 : 0;
    const height = 22 + titleHeight + detailHeight;
    this.ensure(height+14); const top=this.y,t=tones[tone];
    this.box(44,top,524,height,t.fill,palette.rule,5);
    this.page.drawRectangle({x:44,y:792-top-height,width:2.5,height,color:t.ink});
    this.text(title,top+11,60,9.5,true,t.ink,492);
    if(detail)this.text(detail,top+15+titleHeight,60,8.7,false,palette.navy,492);
    this.y += height+14;
  }
  facts(facts: ReportFact[]) {
    for(let offset=0;offset<facts.length;offset+=4) {
      const cells=facts.slice(offset,offset+4),w=524/cells.length;
      const heights=cells.map(c=>this.wrap(c.label.toUpperCase(),6.6,w-22,true).length*10.6+8
        +(c.tone?20:this.wrap(c.value,10,w-22,c.strong??true).length*14)
        +(c.detail?this.wrap(c.detail,7.6,w-22).length*11.6+3:0)+12);
      const height=Math.max(58,...heights); this.ensure(height+8);
      const top=this.y; this.box(44,top,524,height,offset?palette.light:palette.white);
      cells.forEach((c,i)=>{
        const x=44+w*i;
        if(i)this.page.drawLine({start:{x,y:792-top},end:{x,y:792-top-height},color:palette.rule,thickness:.6});
        let y=top+9; y+=this.text(c.label.toUpperCase(),y,x+11,6.6,true,palette.muted,w-22)+6;
        if(c.tone) {this.badge(c.value,x+11,y,c.tone);y+=20;}
        else y+=this.text(c.value,y,x+11,10,c.strong??true,palette.navy,w-22);
        if(c.detail)this.text(c.detail,y+3,x+11,7.6,false,palette.muted,w-22);
      });
      this.y += height;
    }
    this.y += 10;
  }
  amount(cents: number, rightTop: string, rightBottom: string) {
    const lowerLines=this.wrap(rightBottom,8,230).length;
    const nameHeight=this.wrap(rightTop,10,230,true).length*14;
    const bottomTop=23+nameHeight+5;
    const height=Math.max(76,bottomTop+lowerLines*12+16);this.ensure(height+18);
    const top=this.y;this.box(44,top,524,height,palette.navy,palette.navy,8);
    this.text('COMMISSION AMOUNT FOR PAYROLL',top+16,64,7,true,palette.gold,250);
    this.text(reportMoney(cents),top+31,64,30,true,palette.white,250);
    this.text(rightTop,top+23,318,10,true,palette.white,230,'right');
    this.text(rightBottom,top+bottomTop,318,8,false,rgb(.86,.91,.97),230,'right');
    this.y+=height+18;
  }
  section(number: string,title: string,note='') {
    this.ensure(65);this.text(number,this.y,44,16,true,palette.gold,24);
    const h=this.text(title,this.y+2,72,11.5,true,palette.navy,496);
    const titleWidth=this.bold.widthOfTextAtSize(title,11.5);
    const noteWidth=496-titleWidth-20;
    if(note && noteWidth>0 && this.wrap(note,7.5,noteWidth).length===1) {
      this.text(note,this.y+5,72+titleWidth+20,7.5,false,palette.muted,noteWidth,'right');
      this.y+=Math.max(22,h+4)+2;
    } else {
      this.y+=Math.max(22,h+4);
      if(note)this.y+=this.text(note,this.y,44,8,false,palette.muted);
      this.y+=2;
    }
  }
  table(headers: string[], widths: number[], rows: ReportCell[][], total?: ReportCell[]) {
    const padding=10, size=9;
    const headerHeight=Math.max(...headers.map((h,i)=>this.wrap(h.toUpperCase(),6.5,widths[i]-padding*2,true).length*10.5))+16;
    const drawHeader=()=>{
      this.ensure(headerHeight+24);
      this.box(44,this.y,524,headerHeight,palette.light,palette.rule,4);
      let x=44;headers.forEach((h,i)=>{this.text(h.toUpperCase(),this.y+8,x+padding,6.5,true,palette.muted,widths[i]-padding*2);x+=widths[i];});
      this.y+=headerHeight;
    };
    const first = rows[0] ?? total;
    if (first) this.ensure(Math.min(200, headerHeight + Math.max(...first.map((c,i) => this.wrap(c.text,c.tone?7:size,widths[i]-padding*2,!!c.bold).length))*13+16));
    drawHeader();
    const drawRow=(row:ReportCell[],isTotal=false)=>{
      const lines=row.map((c,i)=>this.wrap(c.text,c.tone?7:size,widths[i]-padding*2,c.bold||isTotal));
      let offset=0, remaining=Math.max(...lines.map(l=>l.length));
      // Keep ordinary rows together; only exceptionally tall rows split.
      const rowHeight=Math.max(29,remaining*13+16);
      if(rowHeight<=350 && this.y+rowHeight>this.bottom){this.addPage(true);drawHeader();}
      while(remaining>0){
        if(this.y+30>this.bottom){this.addPage(true);drawHeader();}
        const capacity=Math.max(1,Math.floor((this.bottom-this.y-16)/13));
        const count=Math.min(remaining,capacity),height=Math.max(29,count*13+16);
        this.page.drawRectangle({x:44,y:792-this.y-height,width:524,height,color:palette.white});
        if(isTotal)this.line(this.y,44,524,palette.navy);
        let x=44;
        row.forEach((c,i)=>{
          const slice=lines[i].slice(offset,offset+count);
          if(c.tone && lines[i].length===1 && offset===0) this.badge(c.text,x+padding,this.y+7,c.tone);
          else {
            if(c.progress!==undefined && offset===0) {
              this.page.drawRectangle({x:x+padding,y:792-this.y-18,width:34,height:4,color:palette.light});
              this.page.drawRectangle({x:x+padding,y:792-this.y-18,width:34*Math.max(0,Math.min(1,c.progress)),height:4,color:palette.gold});
            }
            slice.forEach((line,j)=>this.text(line,this.y+8+j*13,x+padding,c.tone?7:size,c.bold||isTotal,isTotal?palette.navy:palette.ink,widths[i]-padding*2,c.align));
          }
          x+=widths[i];
        });
        this.y+=height;this.line(this.y);
        remaining-=count;offset+=count;
        if(remaining){this.addPage(true);drawHeader();}
      }
    };
    rows.forEach(r=>drawRow(r));
    if(total)drawRow(total,true);
    this.y+=10;
  }
  audit(text: string) { this.ensure(35);this.line(this.y);this.y+=8;this.paragraph(text,6.6,false,palette.muted); }
  async finish(footer: string) {
    this.footerText=footer;
    const pages=this.doc.getPages();
    pages.forEach((page,index)=>{
      this.page=page;this.line(740);
      this.text(this.footerText,750,44,7,false,palette.muted,440);
      this.text('Page '+(index+1)+' of '+pages.length,750,493,7,true,palette.navy,75,'right');
    });
    return this.doc.save({useObjectStreams:false});
  }
}
