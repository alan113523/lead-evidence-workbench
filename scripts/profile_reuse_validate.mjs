/** Pure replay of saved judgments. No research, database or network operations. */
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {buildAxesProfile} from './buyer_profile_axes.mjs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const core = p => Object.fromEntries(['schema_version','unit_key','assessed_at','business_model','purchase_purpose',
  'entity_assessment','risk_assessment','evidence_refs','public_research_status','formal_complete'].map(k=>[k,p[k]]));
const reviews = new Map(input.review.units.map(u=>[u.unit_key,u]));
const output = input.analysis.profiles.map(a=>{
  try {
    if(typeof input.analysis.as_of!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(input.analysis.as_of)||!Number.isFinite(Date.parse(input.analysis.as_of))||Date.parse(a.assessed_at)>Date.parse(input.analysis.as_of))throw Error('saved_assessment_after_analysis_cutoff');
    const sources = new Map(input.analysis.evidence.map(e=>[e.id,e]));
    const usable = id => {const s=sources.get(id);return s&&(s.state??'observed')==='observed'&&!['metadata_only','recalled_or_hidden','placeholder','empty','unparsed'].includes(s.content_status);};
    const assessments = [];
    if(a.entity_assessment?.status==='matched')assessments.push(a.entity_assessment);
    if(a.risk_assessment&&(a.risk_assessment.status!=='unexecuted'||Object.values(a.risk_assessment.category_statuses||{}).includes('passed')))assessments.push(a.risk_assessment);
    if(assessments.some(record=>!record.evidence_refs?.length||!record.evidence_refs.every(usable)))throw Error('positive_assessment_requires_available_evidence');
    const p = buildAxesProfile(a,input.analysis.evidence);
    const saved = reviews.get(a.unit_key)?.profile;
    if (!saved || !isDeepStrictEqual(core(p),core(saved))) throw Error('saved_profile_core_differs_from_current_pure_validation');
    return {unit_key:a.unit_key,status:'validated',profile:core(saved)};
  } catch(e) {return {unit_key:a.unit_key,status:'rejected',reason:e.message};}
});
process.stdout.write(JSON.stringify(output));
