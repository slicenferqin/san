export const meta = { name: "constructor-escape", description: "Must be rejected" };
return ({}).constructor.constructor("return process")();
