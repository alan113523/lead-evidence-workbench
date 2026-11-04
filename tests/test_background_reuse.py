"""Synthetic hash chains, raw associations and pure existing-profile replay."""
import copy
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'scripts'))
import background_reuse as reuse
from buyer_background_view import background_view


class SavedReuseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);(self.root/'data').mkdir();(self.root/'scripts').mkdir()
        for name in ['profile_reuse_validate.mjs','buyer_profile_axes.mjs']:shutil.copy2(REPO/'scripts'/name,self.root/'scripts'/name)
        self.patcher=patch.object(reuse,'ROOT',self.root);self.patcher.start();self.addCleanup(self.patcher.stop)
        self.uk='account:synthetic';self.scope={'stores':['syn-A']}
        self.row={'store_key':'syn-A','inquiry_id':'101','row_key':'SYN1','buyer_member_id':'syn-member','excluded':False,'created_at':'2026-01-01T00:00:00Z'}
        self.raw={'key':'syn-A|conv|m1','store_key':'syn-A','conversation_id':'conv','message_id':'m1','inquiry_keys':['syn-A|101'],
                  'variants':[{'message':{'message_id':'m1','direction':'buyer','reply_source':'not_applicable','content_status':'read','sent_at':'2026-01-02T00:00:00Z','text':'We resell these items','automation_flags':{}}}]}
        self.ev={'id':'syn-e1','unit_key':self.uk,'kind':'chat_message','store_key':'syn-A','inquiry_id':'101','buyer_member_id':'syn-member','message_id':'m1',
                 'locator':'chat-message:m1','observed_at':'2026-01-02T01:00:00Z','scope':'current_purchase','quote':'We resell these items'}
        axis=lambda:{'review_state':'reviewed','claims':[],'conflicts':[],'summary':'Synthetic reviewed','uncertainty':'Synthetic limitation','question':None,'reviewed_evidence_refs':[]}
        claim=lambda label:{'label':label,'disposition':'candidate','confidence':'low','inferred':True,'reason':'Synthetic inference','uncertainty':'Synthetic uncertain','evidence_refs':['syn-e1']}
        self.profile={'schema_version':'lew.buyer-profile.v2','unit_key':self.uk,'assessed_at':'2026-01-03T00:00:00Z',
                      'business_model':{**axis(),'claims':[claim('转售经营')]},'purchase_purpose':{**axis(),'claims':[claim('转售')]},
                      'entity_assessment':{'status':'unconfirmed','strength':'low','reason':'Synthetic unconfirmed','evidence_refs':[]},
                      'risk_assessment':{'status':'unexecuted','reason':'Synthetic not executed','category_statuses':{},'evidence_refs':[]}}
        self.unit={'unit_key':self.uk,'inquiry_refs':[{'store_key':'syn-A','inquiry_id':'101','buyer_member_id':'syn-member'}]}
        self.manifest_path=self.root/'plan.json'
        self.prepare()

    def write(self,name,value):
        p=self.root/name;p.write_text(json.dumps(value,ensure_ascii=False),encoding='utf-8')
        return {'path':str(p),'sha256':reuse.sha(p.read_bytes())}

    def prepare(self):
        rawpath=self.root/'messages.jsonl';rawpath.write_text(json.dumps(self.raw)+'\n',encoding='utf-8');rawref={'path':str(rawpath),'sha256':reuse.sha(rawpath.read_bytes())}
        artifact=self.root/'data/artifact.txt';artifact.write_text('SYN frozen artifact',encoding='utf-8')
        chat={'artifactsSha256':{'data/artifact.txt':reuse.sha(artifact.read_bytes())},'associations':[{'store_key':'syn-A','inquiry_id':'101','buyer_member_id':'syn-member','identity':{'conversation_id':'conv'}}]}
        chatref=self.write('chat.json',chat);source=self.write('source.json',{'inquiries':[]});scope=self.write('scope.json',self.scope)
        local={'units':[self.unit],'source_sha256':source['sha256'],'scope_sha256':scope['sha256'],'scope':self.scope}
        localref=self.write('input.json',local)
        analysis={'schema_version':'lew.local-analysis.v2','input_sha256':localref['sha256'],'as_of':'2026-01-03T00:00:00Z','profiles':[self.profile],'evidence':[self.ev]}
        analysisref=self.write('analysis.json',analysis)
        evidence=copy.deepcopy(self.ev);evidence.update(direction='buyer',reply_source='not_applicable',content_status='read',sent_at='2026-01-02T00:00:00Z',automatic=False,chat_bound=True)
        # Call the production pure validator to make a real canonical saved review.
        import subprocess
        js="import{buildAxesProfile}from'./scripts/buyer_profile_axes.mjs';import fs from'node:fs';const v=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(buildAxesProfile(v.p,[v.e])));"
        p=subprocess.run([shutil.which('node'),'--input-type=module','-e',js],cwd=self.root,input=json.dumps({'p':self.profile,'e':evidence}),encoding='utf-8',capture_output=True,check=True)
        review={'schema_version':'lew.buyer-due-diligence-local.v1','analysis_source_sha256':analysisref['sha256'],
                'source_sha256':source['sha256'],'scope_sha256':scope['sha256'],'scope':self.scope,'analysis_as_of':analysis['as_of'],'chat_manifest':chatref,'units':[{**self.unit,'profile':json.loads(p.stdout)}]}
        self.review=review;reviewref=self.write('review.json',review)
        self.data={'analysis_before_exclusive':'2026-01-04T00:00:00Z','rows':[{**self.row,'reviewed_message_binding':{'messages_file':rawref,'messages':[{'message_key':self.raw['key'],'role':'current_inquiry_window'}]}}]}
        finalref=self.write('final.json',self.data);self.final_sha=finalref['sha256']
        self.plan={'schema_version':reuse.SCHEMA,'final_data':finalref,'messages':rawref,'bundles':[{'id':'syn/b1','input':localref,'analysis':analysisref,'review':reviewref,'scope':scope,'source':source,'chat_manifest':chatref}]}
        self.save_plan()

    def save_plan(self):self.manifest_path.write_text(json.dumps(self.plan),encoding='utf-8')
    def load(self):return reuse.load_reuse(self.manifest_path,self.data,self.final_sha)

    def test_actual_pure_replay_scoped_aliases_and_originals_unchanged(self):
        original=copy.deepcopy(self.data);overlays,audit=self.load();o=overlays[('syn-A','101')]
        view=background_view({**self.data['rows'][0],**{k:v for k,v in o.items() if k!='evidence'}},o['evidence'])
        self.assertEqual(view['business']['claims'][0]['state'],'candidate')
        self.assertTrue(view['purpose']['claims'])
        self.assertTrue(view['reuse']['account_binding'])
        self.assertEqual(view['formal'],'未执行正式v3')
        self.assertEqual(self.data,original)
        self.assertEqual(audit['conflicts'],0)

    def test_final_bundle_and_artifact_hash_change_rejected(self):
        with self.assertRaises(ValueError):reuse.load_reuse(self.manifest_path,self.data,'0'*64)
        (self.root/'data/artifact.txt').write_text('changed')
        with self.assertRaisesRegex(ValueError,'artifact changed'):self.load()

    def test_duplicate_bundle_id_and_json_fields_rejected(self):
        self.plan['bundles']*=2;self.save_plan()
        with self.assertRaisesRegex(ValueError,'bundle ID'):self.load()
        self.manifest_path.write_text('{"schema_version":1,"schema_version":2}',encoding='utf-8')
        with self.assertRaisesRegex(ValueError,'duplicate JSON'):self.load()

    def test_exact_buyer_mismatch_rejected(self):
        self.data['rows'][0]['buyer_member_id']='other'
        with self.assertRaisesRegex(ValueError,'member mismatch'):self.load()

    def test_source_chain_and_frozen_messages_mismatch_rejected(self):
        self.plan['bundles'][0]['analysis']['sha256']='0'*64;self.save_plan()
        with self.assertRaises(ValueError):self.load()
        self.prepare();self.data['rows'][0]['reviewed_message_binding']['messages_file']['sha256']='0'*64
        with self.assertRaisesRegex(ValueError,'row declaration'):self.load()

    def test_conflicting_original_associations_and_versions_rejected(self):
        for mutation in ['scope','variants','quote','hidden']:
            self.prepare()
            raw=copy.deepcopy(self.raw)
            if mutation=='scope':raw['inquiry_ids']=['other-inquiry']
            elif mutation=='variants':raw['variants']*=2
            elif mutation=='quote':raw['variants'][0]['message']['text']='unrelated'
            else:raw['variants'][0]['message']['content_status']='recalled_or_hidden'
            p=self.root/'messages.jsonl';p.write_text(json.dumps(raw)+'\n',encoding='utf-8');digest=reuse.sha(p.read_bytes())
            self.plan['messages']['sha256']=digest;self.data['rows'][0]['reviewed_message_binding']['messages_file']['sha256']=digest;self.save_plan()
            with self.assertRaises(ValueError):self.load()

    def test_current_purchase_outside_window_rejected(self):
        with self.assertRaises(ValueError):
            reuse.bind_saved_evidence({'evidence':[self.ev]},json.loads((self.root/'chat.json').read_text()),{self.raw['key']:self.raw},
                {('syn-A','101'):{**self.data['rows'][0],'_cutoff':'2026-01-01T12:00:00Z'}})

    def test_equivalent_bundle_dedup_keeps_provenance(self):
        duplicate=copy.deepcopy(self.plan['bundles'][0]);duplicate['id']='syn/b2';self.plan['bundles'].append(duplicate);self.save_plan()
        o,a=self.load();self.assertEqual(len(o),1);self.assertEqual(len(o[('syn-A','101')]['background_reuse']['equivalent_reviews']),2)

    def test_conflicting_saved_profiles_not_auto_selected(self):
        first=copy.deepcopy(self.plan['bundles'][0])
        for field in ['analysis','review']:
            p=self.root/f'previous-{field}.json';shutil.copy2(first[field]['path'],p);first[field]['path']=str(p)
        self.profile['business_model']['claims'][0]['label']='Different saved judgment';self.prepare()
        self.plan['bundles'][0]['id']='syn/b2';self.plan['bundles'].insert(0,first);self.save_plan()
        o,a=self.load()
        self.assertIsNone(o[('syn-A','101')]['profile'])
        self.assertEqual(a['conflicts'],1)

    def test_existing_frozen_profile_not_overwritten(self):
        self.data['rows'][0]['profile']={'existing':'kept'}
        o,a=self.load();self.assertNotIn(('syn-A','101'),o)
        self.assertEqual(self.data['rows'][0]['profile'],{'existing':'kept'})

    def test_frozen_window_binding_and_byte_position_mismatch_rejected(self):
        self.data['rows'][0]['reviewed_message_binding']['messages'][0]['role']='supplementary_history'
        with self.assertRaisesRegex(ValueError,'current-window'):self.load()
        self.data['rows'][0]['reviewed_message_binding']['messages'][0].update(role='current_inquiry_window',line=99)
        with self.assertRaisesRegex(ValueError,'byte position'):self.load()

    def test_empty_original_chat_identity_rejected(self):
        chat=json.loads((self.root/'chat.json').read_text())
        chat['associations'][0]['identity']['conversation_id']=''
        bad=copy.deepcopy(self.ev);bad['message_id']=''
        with self.assertRaisesRegex(ValueError,'non-empty exact chat identity'):
            reuse.bind_saved_evidence({'evidence':[bad]},chat,{},
                {('syn-A','101'):{**self.data['rows'][0],'_cutoff':'2026-01-04T00:00:00Z'}})

    def test_metadata_only_cannot_support_a_saved_positive_claim(self):
        p=self.root/'messages.jsonl';raw=copy.deepcopy(self.raw);raw['variants'][0]['message']['content_status']='metadata_only'
        p.write_text(json.dumps(raw)+'\n',encoding='utf-8');digest=reuse.sha(p.read_bytes())
        self.plan['messages']['sha256']=digest;self.data['rows'][0]['reviewed_message_binding']['messages_file']['sha256']=digest;self.save_plan()
        o,a=self.load()
        self.assertEqual(o[('syn-A','101')]['background_reuse']['status'],'已有复核记录未复用')
        self.assertTrue(a['rejected'])

    def test_metadata_only_cannot_upgrade_entity_or_risk_assessment(self):
        self.profile['business_model']['claims']=[];self.profile['purchase_purpose']['claims']=[]
        self.profile['business_model']['reviewed_evidence_refs']=['syn-e1']
        self.profile['entity_assessment'].update(status='matched',strength='medium',evidence_refs=['syn-e1'])
        self.profile['risk_assessment'].update(status='reviewed',category_statuses={'legal':'passed'},evidence_refs=['syn-e1'])
        self.prepare()
        p=self.root/'messages.jsonl';raw=copy.deepcopy(self.raw);raw['variants'][0]['message']['content_status']='metadata_only'
        p.write_text(json.dumps(raw)+'\n',encoding='utf-8');digest=reuse.sha(p.read_bytes())
        self.plan['messages']['sha256']=digest;self.data['rows'][0]['reviewed_message_binding']['messages_file']['sha256']=digest;self.save_plan()
        o,a=self.load()
        self.assertNotIn('profile',o[('syn-A','101')])
        self.assertIn('positive_assessment_requires_available_evidence',a['rejected'][0]['reason'])

    def test_general_business_cannot_use_message_after_observation_or_cutoff(self):
        self.ev['scope']='general_business';self.profile['purchase_purpose']['claims']=[];self.prepare()
        for sent, cutoff in [('2026-01-10T00:00:00Z','2026-01-11T00:00:00Z'),('2026-01-02T00:00:00Z','2026-01-01T00:00:00Z')]:
            raw=copy.deepcopy(self.raw);raw['variants'][0]['message']['sent_at']=sent
            p=self.root/'messages.jsonl';p.write_text(json.dumps(raw)+'\n',encoding='utf-8');digest=reuse.sha(p.read_bytes())
            self.plan['messages']['sha256']=digest;self.data['rows'][0]['reviewed_message_binding']['messages_file']['sha256']=digest
            self.data['analysis_before_exclusive']=cutoff;self.save_plan()
            with self.assertRaisesRegex(ValueError,'after observation or frozen cutoff'):self.load()


if __name__=='__main__':unittest.main()
