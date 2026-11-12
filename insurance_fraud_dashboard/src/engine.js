/* Pure inference and validation functions. No DOM, network, or generated reasons. */
const FIELD_MAP=Object.fromEntries(PAYLOAD.fields.map(f=>[f.name,f]));
const sigmoid=z=>z>=0?1/(1+Math.exp(-z)):Math.exp(z)/(1+Math.exp(z));
function validateInputs(inputs){
 const errors=[],warnings=[],clean={};
 for(const field of PAYLOAD.fields){
  const {name,label}=field,s=PAYLOAD.model.spec[name];
  if(!Object.prototype.hasOwnProperty.call(inputs,name)){errors.push({field:name,message:label+' 항목이 누락되었습니다.'});continue;}
  let value=inputs[name];if(value===''||value===undefined||value==='__MISSING__')value=null;
  if(value===null){
   if(field.required){errors.push({field:name,message:label+' 항목을 입력해 주세요.'});continue;}
   if(field.type==='category'&&!s.categories.includes('__MISSING__')){errors.push({field:name,message:label+' 항목에는 미상을 사용할 수 없습니다.'});continue;}
   clean[name]=null;continue;
  }
  if(field.type==='number'){
   if(typeof value!=='number'||!Number.isFinite(value)){errors.push({field:name,message:label+' 항목은 유효한 숫자여야 합니다.'});continue;}
   if(field.integer&&!Number.isInteger(value)){errors.push({field:name,message:label+' 항목은 정수로 입력해 주세요.'});continue;}
   if((field.min!==null&&value<field.min)||(field.max!==null&&value>field.max)){errors.push({field:name,message:label+' 항목의 허용 범위를 확인해 주세요.'});continue;}
   if(value<s.min||value>s.max)warnings.push({field:name,message:label+' 값이 학습 자료에서 본 범위 밖입니다. 입력과 예측 결과를 주의해서 확인하세요.'});
  }else if(typeof value!=='string'||!s.categories.includes(value)){errors.push({field:name,message:label+' 항목의 선택값이 올바르지 않습니다.'});continue;}
  clean[name]=value;
 }
 return {valid:errors.length===0,inputs:clean,errors,warnings};
}
function predictRaw(inputs){
 const m=PAYLOAD.model;let z=m.intercept;const contributions=[],processing=[];
 for(const name of m.cols){
  const s=m.spec[name],v=inputs[name];let part,used;
  if(s.type==='number'){
   used=v===null?s.median:v;part=s.coef*(used-s.mean)/s.scale;
   if(v===null)processing.push({field:name,method:'median',used_value:used});
  }else{
   used=v===null?'__MISSING__':v;
   if(!Object.prototype.hasOwnProperty.call(s.weights,used))throw new Error('Unknown category: '+name);
   part=s.weights[used];if(v===null)processing.push({field:name,method:'missing_category',used_value:'__MISSING__'});
  }
  z+=part;contributions.push({field:name,input_value:v,used_value:used,contribution:part-s.reference});
 }
 const probability=sigmoid(z),sum=contributions.reduce((s,r)=>s+r.contribution,0);
 return {model_version:m.version,probability,score:100*probability,base_log_odds:m.base,log_odds:z,
  contribution_sum:sum,reconstruction_error:Math.abs(m.base+sum-z),contributions,input_processing:processing};
}
function analyzeCase(inputs){
 const validation=validateInputs(inputs);
 if(!validation.valid)return {status:'invalid',errors:validation.errors};
 const prediction=predictRaw(validation.inputs);
 if(!Number.isFinite(prediction.score)||prediction.reconstruction_error>1e-10)throw new Error('Prediction integrity error');
 return {status:'ok',inputs:validation.inputs,warnings:validation.warnings,...prediction};
}
function decision(score,threshold){return score>=threshold?'additional_review':'standard_review'}
