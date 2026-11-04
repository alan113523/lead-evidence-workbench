import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {dataPath} from './chat_collection.mjs';
import {LOCAL_VERSION} from './buyer_due_diligence_local.mjs';
import {PROFILE_AXES_VERSION,AXIS_FIELDS,profileAxisColumns} from './buyer_profile_axes.mjs';
import {OPPORTUNITY_FIELDS,OPPORTUNITY_VERSION} from './opportunity_review.mjs';
import {DEPTH_FIELDS,depthColumns} from './deep_communication.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const check=(ok,code)=>{if(!ok)throw Error(code);};
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const key=row=>JSON.stringify([row.store_key,row.inquiry_id]);
const nonempty=value=>value!=null&&value!=='';
const protectedDepthValue=(value,status,fillMissingOnly)=>nonempty(value)&&(
  fillMissingOnly&&!(typeof value==='string'&&value.trim()==='待确认')||
  status==='未核实'&&!['待确认','待评估','未核实'].includes(value));
const fields={...AXIS_FIELDS,...OPPORTUNITY_FIELDS,...DEPTH_FIELDS,role:'买家角色',purchase_intent:'采购意图',quantity:'明确采购数量',quantity_unit:'数量单位',
  next_action:'下一步',action_owner:'执行人',action_due:'约定日期'};

export function buildTrackingPatch(tables,review,reviewHash,{fillMissingOnly=false}={}){
  check(tables.schema_version==='lew.tracking-tables.v1'&&review.schema_version===LOCAL_VERSION&&
    /^[a-f0-9]{64}$/.test(tables.workbook_sha256)&&/^[a-f0-9]{64}$/.test(reviewHash),'invalid_review_patch_input');
  const rows=new Map(),changes=[],cells=new Set(),depthGroupConflicts=[];let missingFields=0,unavailableRows=0,preservedNonempty=0,purposeScopeGaps=0;
  for(const row of tables.inquiries){check(!rows.has(key(row)),'duplicate_workbook_inquiry');rows.set(key(row),row);}
  for(const unit of review.units){
    const values={};
    const axes=unit.profile?.schema_version===PROFILE_AXES_VERSION;
    const axisSection=field=>field.startsWith('business_model')?'business_model':field.startsWith('purchase_purpose')?'purchase_purpose':field;
    if(axes){
      for(const [field,value] of Object.entries(profileAxisColumns(unit.profile)))
        if(unit.profile[axisSection(field)].evidence_refs?.length)values[field]=value;
    }else if(unit.profile&&unit.profile.role!=='待确认')values.role=unit.profile.role;
    const intent=unit.profile?.procurement_intent;
    if(intent?.buyer_confirmed===true&&intent.quantity_unit==='台'&&intent.evidence_refs?.length){
      if(unit.profile.large_volume_intent==='supported')values.purchase_intent='大额采购意向（AI数量判断）';
      if(unit.profile.large_volume_intent==='below_threshold')values.purchase_intent='明确数量未达大额门槛（AI判断）';
      if(Number.isSafeInteger(intent.single_order_quantity)&&intent.single_order_quantity>=0){
        values.quantity=intent.single_order_quantity;values.quantity_unit='台';
      }
    }
    if(unit.action){
      check(unit.action.status==='ai_proposed'&&unit.action.executed===false,'action_execution_claim_forbidden');
      values.next_action=`[AI草稿] ${unit.action.next_action}`;
      if(unit.action.owner)values.action_owner=unit.action.owner;
      if(unit.action.due_date)values.action_due=unit.action.due_date;
    }
    for(const ref of unit.inquiry_refs){
      const row=rows.get(key(ref));if(!row){unavailableRows++;continue;}
      check(row.source_sheet==='商机录入'&&Number.isInteger(row.source_row)&&row.source_row>0,'workbook_row_provenance_required');
      const purposeScoped=!axes||key(unit.profile.purchase_purpose.inquiry_scope||{})===key(ref);
      if(!purposeScoped&&Object.keys(values).some(field=>field.startsWith('purchase_purpose')))purposeScopeGaps++;
      const rowValues={...values},opportunity=ref.opportunity_review;
      const opportunityReviewed=opportunity?.schema_version===OPPORTUNITY_VERSION&&opportunity.review_state==='reviewed';
      if(opportunityReviewed){
        check(key(opportunity)===key(ref)&&opportunity.unit_key===unit.unit_key,'opportunity_patch_scope_mismatch');
        rowValues.product=opportunity.product;rowValues.opportunity_quality=opportunity.quality;rowValues.opportunity_quality_basis=opportunity.summary;
        rowValues.next_action=`[AI草稿] ${opportunity.next_action}`;
        delete rowValues.action_owner;delete rowValues.action_due;
        Object.assign(rowValues,depthColumns(opportunity));
      }
      // A protected part of a judgment must not be paired with new parts from another assessment.
      const protectedDepthFields=Object.entries(rowValues).filter(([field,value])=>{
        const p=row.field_provenance?.[field];
        return Object.hasOwn(DEPTH_FIELDS,field)&&p?.cell&&p.status!=='missing_header'&&!same(p.value,value)&&
          protectedDepthValue(p.value,opportunity.deep_communication.status,fillMissingOnly);
      }).map(([field])=>({field,cell:row.field_provenance[field].cell}));
      const preserveDepthGroup=protectedDepthFields.length>0;
      if(preserveDepthGroup)depthGroupConflicts.push({store_key:ref.store_key,inquiry_id:ref.inquiry_id,
        reason:'protected_depth_group_conflict',protected_fields:protectedDepthFields});
      for(const [field,value] of Object.entries(rowValues)){
        const p=row.field_provenance?.[field];
        if(field.startsWith('purchase_purpose')&&!purposeScoped)continue;
        if(!p?.cell||p.status==='missing_header'){missingFields++;continue;}
        check(p.sheet==='商机录入'&&p.header===fields[field]&&/^[A-Z]{1,3}[1-9]\d*$/.test(p.cell)&&
          Number(p.cell.match(/\d+$/)[0])===row.source_row&&!p.formula&&p.status==='workbook_value','unsafe_field_provenance');
        let next=value;
        if(field==='action_due'&&p.value&&typeof p.value==='object')next={type:p.value.type,value:value+(p.value.type==='datetime'?'T00:00:00':'')};
        if(same(p.value,next))continue;
        if(Object.hasOwn(DEPTH_FIELDS,field)&&preserveDepthGroup){if(nonempty(p.value))preservedNonempty++;continue;}
        if(fillMissingOnly&&p.value!=null&&p.value!==''&&!(typeof p.value==='string'&&p.value.trim()==='待确认')){preservedNonempty++;continue;}
        check(!cells.has(p.cell),'duplicate_patch_cell');cells.add(p.cell);
        const isDepth=Object.hasOwn(DEPTH_FIELDS,field);
        const isOpportunity=isDepth||Object.hasOwn(OPPORTUNITY_FIELDS,field)||field==='next_action'&&opportunityReviewed;
        const section=isOpportunity?'opportunity':field.startsWith('action_')||field==='next_action'?'action':'profile';
        const refs=isDepth?opportunity.deep_communication.evidence_refs:isOpportunity?opportunity.evidence_refs:axes&&Object.hasOwn(AXIS_FIELDS,field)?unit.profile[axisSection(field)].evidence_refs:
          ['purchase_intent','quantity','quantity_unit'].includes(field)?intent?.evidence_refs:unit[section]?.evidence_refs;
        check(refs?.length>0||isDepth&&opportunity.deep_communication.status==='未核实'||isOpportunity&&opportunity.quality==='待判断'&&opportunity.product==='待确认','patch_assessment_evidence_required');
        changes.push({sheet:p.sheet,cell:p.cell,expected:p.value,value:next,
          evidence_ref:`local-review:${reviewHash}:${unit.unit_key}:${isOpportunity?`${section}:${ref.store_key}:${ref.inquiry_id}`:axes&&Object.hasOwn(AXIS_FIELDS,field)?axisSection(field):section}`});
      }
    }
  }
  return {patch:{schema_version:'lew.tracking-patch.v1',workbook_sha256:tables.workbook_sha256,changes},
    status:changes.length?'patch_prepared':'no_changes',changed_cell_count:changes.length,missing_field_count:missingFields,
    previous_units_without_current_row:unavailableRows,preserved_nonempty_cell_count:preservedNonempty,purchase_purpose_scope_gap_count:purposeScopeGaps,
    depth_group_conflict_count:depthGroupConflicts.length,depth_group_conflicts:depthGroupConflicts};
}

export function prepareTrackingPatch({tables,review,out,fillMissingOnly=false},projectRoot=root){
  const tablesPath=dataPath(tables,projectRoot),reviewPath=dataPath(review,projectRoot),outPath=dataPath(out,projectRoot);
  check(![tablesPath,reviewPath].includes(outPath),'source_overwrite_forbidden');
  const tablesBytes=readFileSync(tablesPath),reviewBytes=readFileSync(reviewPath),parsed=JSON.parse(reviewBytes);
  const tableInput=JSON.parse(tablesBytes),binding=parsed.tracking_tables;
  check((binding?binding.sha256===hash(tablesBytes)&&binding.workbook_sha256===tableInput.workbook_sha256:
    parsed.source_sha256===hash(tablesBytes))&&/^[a-f0-9]{64}$/.test(parsed.analysis_source_sha256),'review_source_changed');
  const result=buildTrackingPatch(tableInput,parsed,hash(reviewBytes),{fillMissingOnly}),bytes=JSON.stringify(result.patch,null,2)+'\n';
  if(result.status==='no_changes')return {status:result.status,changed_cell_count:0,missing_field_count:result.missing_field_count,
    previous_units_without_current_row:result.previous_units_without_current_row,purchase_purpose_scope_gap_count:result.purchase_purpose_scope_gap_count,
    preserved_nonempty_cell_count:result.preserved_nonempty_cell_count,depth_group_conflict_count:result.depth_group_conflict_count,
    depth_group_conflicts:result.depth_group_conflicts};
  if(existsSync(outPath))check(readFileSync(outPath,'utf8')===bytes,'existing_patch_conflict');
  else {mkdirSync(dirname(outPath),{recursive:true});writeFileSync(outPath,bytes,{flag:'wx',mode:0o600});}
  const {patch,...safe}=result;return {...safe,out:outPath,workbook_sha256:patch.workbook_sha256,review_sha256:hash(reviewBytes)};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const args=process.argv.slice(2),a={};
    for(let i=0;i<args.length;i+=2){check(['--tables','--review','--out','--fill-missing-only'].includes(args[i])&&args[i+1]&&!args[i+1].startsWith('--')&&!a[args[i]],'invalid_arguments');a[args[i]]=args[i+1];}
    check(a['--fill-missing-only']==null||['true','false'].includes(a['--fill-missing-only']),'invalid_arguments');
    console.log(JSON.stringify(prepareTrackingPatch({tables:a['--tables'],review:a['--review'],out:a['--out'],fillMissingOnly:a['--fill-missing-only']==='true'})));
  }catch(error){console.error(JSON.stringify({error:/^[a-z_]+$/.test(error.message)?error.message:'review_patch_error'}));process.exitCode=1;}
}
