export function userErrorMessage(error){
  return String(error?.message??error??'Something went wrong. Please try again.')
    .replace(/^Error invoking remote method ['"][^'"]+['"]:\s*(?:(?:Error|RangeError):\s*)?/,'')
    .replace(/^(?:Error|RangeError):\s*/,'');
}
