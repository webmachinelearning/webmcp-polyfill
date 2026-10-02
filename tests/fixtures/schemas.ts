// Chromium's html_form_mcp_tool_test.cc schema cases at dbdbb13fd74c, checked in Chrome Canary
// 156.0.8069.0, leaving out the flagged file input and form-associated custom element cases.
export const chromiumSchemas: { name: string; html: string; schema: object }[] = [
  {
    name: "ParameterSchema_Disabled",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text"> <input name="text2" type="text" disabled> <textarea name="area1" disabled> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_Readonly",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text"> <input name="text2" type="text" readonly> <textarea name="area1" readonly> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_Required",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text"> <input name="text2" type="text" required> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}, "text2": {"type": "string"}}, "required": ["text2"]},
  },
  {
    name: "ParameterSchema_TextInput_Description",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text" toolparamdescription="Some nice text"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "Some nice text"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_Label",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label for="text">Some text</label> <input id="text" name="text1" type="text"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "Some text"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_Label_Multiple",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label for="text">Label one</label> <label for="text">Label two</label> <input id="text" name="text1" type="text"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "Label one; Label two"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_AriaDescription",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text" aria-description="ARIA"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "ARIA"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_PreferLabelOverAria",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label for="text">Label</label> <input id="text" name="text1" type="text" aria-description="ARIA"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "Label"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_PreferAttrOverLabel",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label for="text">Label</label> <input id="text" name="text1" type="text" toolparamdescription="ATTR" aria-description="ARIA"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "ATTR"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextInput_DuplicateName",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="text1" type="text"> <input name="text2" type="text"> <input name="text2" type="text"> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_ImplicitLabelText",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label> LABEL <select name="select" required> <option value="Option 1">This is option 1</option> <option value="Option 2">This is option 2</option> <option value="Option 3">This is option 3</option> </select> <button>Button text</button> </label> </form>`,
    schema: {"type": "object", "properties": {"select": {"type": "string", "anyOf": [{"type": "string", "const": "Option 1", "title": "This is option 1"}, {"type": "string", "const": "Option 2", "title": "This is option 2"}, {"type": "string", "const": "Option 3", "title": "This is option 3"}], "enum": ["Option 1", "Option 2", "Option 3"], "description": "LABEL"}}, "required": ["select"]},
  },
  {
    name: "ParameterSchema_Select",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <select name="select" required> <option value="Option 1">This is option 1</option> <option value="Option 2">This is option 2</option> <option value="Option 3">This is option 3</option> </select> </form>`,
    schema: {"type": "object", "properties": {"select": {"type": "string", "anyOf": [{"type": "string", "const": "Option 1", "title": "This is option 1"}, {"type": "string", "const": "Option 2", "title": "This is option 2"}, {"type": "string", "const": "Option 3", "title": "This is option 3"}], "enum": ["Option 1", "Option 2", "Option 3"]}}, "required": ["select"]},
  },
  {
    name: "ParameterSchema_Select_Multiple",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <select name="select" multiple required> <option value="Option 1">This is option 1</option> <option value="Option 2">This is option 2</option> <option value="Option 3">This is option 3</option> </select> </form>`,
    schema: {"type": "object", "properties": {"select": {"type": "array", "items": {"type": "string", "anyOf": [{"type": "string", "const": "Option 1", "title": "This is option 1"}, {"type": "string", "const": "Option 2", "title": "This is option 2"}, {"type": "string", "const": "Option 3", "title": "This is option 3"}], "enum": ["Option 1", "Option 2", "Option 3"]}, "uniqueItems": true}}, "required": ["select"]},
  },
  {
    name: "ParameterSchema_NumberInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="num1" type="number" min="10" max="100"> <input name="num2" type="number" min="30" max="60" step="10"> <input name="num3" type="number" min="15" step="10"> <input name="num4" type="number" step="13"> <input name="num5" type="number" step="0.1"> <input name="num6" type="number" min="0.15" step="0.1"> <input name="num7" type="number" pattern="[1-4]{3}"> </form>`,
    schema: {"type": "object", "properties": {"num1": {"type": "number", "minimum": 10, "maximum": 100, "multipleOf": 1}, "num2": {"type": "number", "minimum": 30, "maximum": 60, "multipleOf": 10}, "num3": {"type": "number", "minimum": 15}, "num4": {"type": "number", "multipleOf": 13}, "num5": {"type": "number", "multipleOf": 0.1}, "num6": {"type": "number", "minimum": 0.15}, "num7": {"type": "number", "multipleOf": 1, "pattern": "[1-4]{3}"}}, "required": []},
  },
  {
    name: "ParameterSchema_NumberInput_MinOnly",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="num1" type="number" min="10"> </form>`,
    schema: {"type": "object", "properties": {"num1": {"type": "number", "minimum": 10, "multipleOf": 1}}, "required": []},
  },
  {
    name: "ParameterSchema_NumberInput_MaxOnly",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="num1" type="number" max="100"> </form>`,
    schema: {"type": "object", "properties": {"num1": {"type": "number", "maximum": 100, "multipleOf": 1}}, "required": []},
  },
  {
    name: "ParameterSchema_Checkbox",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="check1" type="checkbox"> </form>`,
    schema: {"type": "object", "properties": {"check1": {"type": "boolean"}}, "required": []},
  },
  {
    name: "ParameterSchema_Checkbox_Multiple",
    html: `<form id=form toolname="mytool" tooldescription="pick fruits you like"> <label> <input id="apple" name="fruit" type="checkbox" value="apple"> Apple </label> <label> <input id="melon" name="fruit" type="checkbox" value="melon"> Melon </label> <label> <input id="grape" name="fruit" type="checkbox" value="grape"> Grape </label> </form>`,
    schema: {"type": "object", "properties": {"fruit": {"type": "array", "items": {"type": "string", "anyOf": [{"type": "string", "const": "apple", "title": "Apple"}, {"type": "string", "const": "melon", "title": "Melon"}, {"type": "string", "const": "grape", "title": "Grape"}], "enum": ["apple", "melon", "grape"]}, "uniqueItems": true}}, "required": []},
  },
  {
    name: "ParameterSchema_Checkbox_IgnoreToolParamAttributes",
    html: `<form id=form toolname="mytool" tooldescription="pick fruits you like"> <input id="apple" name="fruit" type="checkbox" value="apple" toolparamdescription="ERR1" > <input id="melon" name="fruit" type="checkbox" value="melon" toolparamdescription="ERR2" > <input id="grape" name="fruit" type="checkbox" value="grape"> </form>`,
    schema: {"type": "object", "properties": {"fruit": {"type": "array", "items": {"type": "string", "anyOf": [{"type": "string", "const": "apple"}, {"type": "string", "const": "melon"}, {"type": "string", "const": "grape"}], "enum": ["apple", "melon", "grape"]}, "uniqueItems": true}}, "required": []},
  },
  {
    name: "ParameterSchema_RangeInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="range1" type="range" min="0" max="50"> </form>`,
    schema: {"type": "object", "properties": {"range1": {"type": "number", "minimum": 0, "maximum": 50, "multipleOf": 1}}, "required": []},
  },
  {
    name: "ParameterSchema_RangeInput_Defaults",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="range1" type="range"> </form>`,
    schema: {"type": "object", "properties": {"range1": {"type": "number", "minimum": 0, "maximum": 100, "multipleOf": 1}}, "required": []},
  },
  {
    name: "ParameterSchema_RangeInput_Step",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="range1" type="range" min="0" max="10" step="2"> </form>`,
    schema: {"type": "object", "properties": {"range1": {"type": "number", "minimum": 0, "maximum": 10, "multipleOf": 2}}, "required": []},
  },
  {
    name: "ParameterSchema_RangeInput_StepBaseOffset",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="range1" type="range" min="1" max="11" step="2"> </form>`,
    schema: {"type": "object", "properties": {"range1": {"type": "number", "minimum": 1, "maximum": 11}}, "required": []},
  },
  {
    name: "ParameterSchema_DateInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="date1" type="date"> </form>`,
    schema: {"type": "object", "properties": {"date1": {"type": "string", "format": "date", "description": "Dates MUST be provided in 'YYYY-MM-DD' format."}}, "required": []},
  },
  {
    name: "ParameterSchema_DatetimeLocalInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="datetime1" type="datetime-local"> <input name="datetime2" type="datetime-local" step="1"> <input name="datetime3" type="datetime-local" step="0.001"> </form>`,
    schema: {"type": "object", "properties": {"datetime1": {"type": "string", "format": "^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$"}, "datetime2": {"type": "string", "format": "^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$"}, "datetime3": {"type": "string", "format": "^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$"}}, "required": []},
  },
  {
    name: "ParameterSchema_MonthInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="month1" type="month"> </form>`,
    schema: {"type": "object", "properties": {"month1": {"type": "string", "format": "^[0-9]{4}-(0[1-9]|1[0-2])$"}}, "required": []},
  },
  {
    name: "ParameterSchema_WeekInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="week1" type="week"> </form>`,
    schema: {"type": "object", "properties": {"week1": {"type": "string", "format": "^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$"}}, "required": []},
  },
  {
    name: "ParameterSchema_TimeInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="time1" type="time"> <input name="time2" type="time" step="1"> <input name="time3" type="time" step="0.001"> </form>`,
    schema: {"type": "object", "properties": {"time1": {"type": "string", "format": "^([01][0-9]|2[0-3]):[0-5][0-9]$"}, "time2": {"type": "string", "format": "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$"}, "time3": {"type": "string", "format": "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\\.[0-9]{1,3})?)?$"}}, "required": []},
  },
  {
    name: "ParameterSchema_ColorInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="color1" type="color"> </form>`,
    schema: {"type": "object", "properties": {"color1": {"type": "string", "format": "^#[0-9a-zA-Z]{6}$"}}, "required": []},
  },
  {
    name: "ParameterSchema_TextArea",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <textarea name="area1"> </form>`,
    schema: {"type": "object", "properties": {"area1": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_BaseTextInput",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="email1" type="email"> <input name="search1" type="search"> <input name="tel1" type="tel"> <input name="url1" type="url"> <input name="hidden1" type="hidden"> <input name="hidden2" type="hidden" toolparamdescription="DESC"> </form>`,
    schema: {"type": "object", "properties": {"email1": {"type": "string"}, "search1": {"type": "string"}, "tel1": {"type": "string"}, "url1": {"type": "string"}, "hidden2": {"type": "string", "description": "DESC"}}, "required": []},
  },
  {
    name: "ParameterSchema_BaseTextInputPatternAttribute",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input name="email1" type="email" pattern="[A-Z]{10}"> <input name="search1" type="search" pattern="[A-Z]{10}"> <input name="tel1" type="tel" pattern="[A-Z]{10}"> <input name="url1" type="url" pattern="[A-Z]{10}"> <input name="hidden1" type="hidden" pattern="[A-Z]{10}"> <input name="hidden2" type="hidden" toolparamdescription="DESC" pattern="[A-Z]{10}"> <input name="invalid_pattern" type="text" toolparamdescription="invalid pattern input" pattern="[)]"> </form>`,
    schema: {"type": "object", "properties": {"email1": {"type": "string", "pattern": "[A-Z]{10}"}, "search1": {"type": "string", "pattern": "[A-Z]{10}"}, "tel1": {"type": "string", "pattern": "[A-Z]{10}"}, "url1": {"type": "string", "pattern": "[A-Z]{10}"}, "hidden2": {"type": "string", "pattern": "[A-Z]{10}", "description": "DESC"}, "invalid_pattern": {"type": "string", "description": "invalid pattern input"}}, "required": []},
  },
  {
    name: "ParameterSchema_Radio",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <label> <input type=radio name=size value=s> Small </label> <label> <input type=radio name=size value=m> Medium </label> <label> <input type=radio name=size value=l> Large </label> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s", "title": "Small"}, {"type": "string", "const": "m", "title": "Medium"}, {"type": "string", "const": "l", "title": "Large"}], "enum": ["s", "m", "l"]}}, "required": []},
  },
  {
    name: "ParameterSchema_Radio_Multiple",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input type=radio name=size value=s> <input type=radio name=size value=m> <input type=radio name=size value=l> <input type=radio name=item value=hoodie> <input type=radio name=item value=shirt> <input type=radio name=item value=hat> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}, {"type": "string", "const": "l"}], "enum": ["s", "m", "l"]}, "item": {"type": "string", "anyOf": [{"type": "string", "const": "hoodie"}, {"type": "string", "const": "shirt"}, {"type": "string", "const": "hat"}], "enum": ["hoodie", "shirt", "hat"]}}, "required": []},
  },
  {
    name: "ParameterSchema_Radio_MixedType",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input type=text name=foo> <input type=radio name=size value=s> <input type=radio name=size value=m> <input type=radio name=size value=l> <input type=text name=size> <!-- Oops! --> </form>`,
    schema: {"type": "object", "properties": {"foo": {"type": "string"}}, "required": []},
  },
  {
    name: "ParameterSchema_Radio_Required",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input type=radio name=size value=s> <input type=radio name=size value=m required> <input type=radio name=size value=l> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}, {"type": "string", "const": "l"}], "enum": ["s", "m", "l"]}}, "required": ["size"]},
  },
  {
    name: "ParameterSchema_Radio_IgnoreToolParamDescription",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <input type=radio name=size value=s toolparamdescription="ERR1"> <input type=radio name=size value=m toolparamdescription="ERR2"> <input type=radio name=size value=l toolparamdescription="ERR3"> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}, {"type": "string", "const": "l"}], "enum": ["s", "m", "l"]}}, "required": []},
  },
  {
    name: "FieldsetDescription_Radio_Basic",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="FIELDSET_DESC"> <input type=radio name=size value=s> <input type=radio name=size value=m> <input type=radio name=size value=l> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}, {"type": "string", "const": "l"}], "enum": ["s", "m", "l"], "description": "FIELDSET_DESC"}}, "required": []},
  },
  {
    name: "FieldsetDescription_Radio_Nested",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="OUTER_DESC"> <fieldset toolparamdescription="INNER_DESC"> <input type=radio name=size value=s> <input type=radio name=size value=m> </fieldset> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}], "enum": ["s", "m"], "description": "INNER_DESC"}}, "required": []},
  },
  {
    name: "FieldsetDescription_Radio_NoAttrOnNearest",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="OUTER_DESC"> <fieldset> <input type=radio name=size value=s> <input type=radio name=size value=m> </fieldset> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}], "enum": ["s", "m"]}}, "required": []},
  },
  {
    name: "FieldsetDescription_Radio_CommonOutside",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="FIELDSET_DESC"> <div id=d1> <input type=radio name=size value=s> </div> <div id=d2> <input type=radio name=size value=m> </div> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}], "enum": ["s", "m"], "description": "FIELDSET_DESC"}}, "required": []},
  },
  {
    name: "FieldsetDescription_Radio_NoCommonFieldset",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="FIELDSET1"> <input type=radio name=size value=s> </fieldset> <fieldset toolparamdescription="FIELDSET2"> <input type=radio name=size value=m> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}], "enum": ["s", "m"]}}, "required": []},
  },
  {
    name: "FieldsetDescription_Single_Text",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="FIELDSET_DESC"> <input type=text name=text1> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string"}}, "required": []},
  },
  {
    name: "FieldsetDescription_Single_Text_Describes_Self",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="FIELDSET_DESC"> <input type=text name=text1 toolparamdescription="INPUT_DESC"> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"text1": {"type": "string", "description": "INPUT_DESC"}}, "required": []},
  },
  {
    name: "FieldsetDescription_LimitToForm",
    html: `<fieldset toolparamdescription="OUTSIDE"> <form id="form" toolname="mytool" tooldescription="perform task"> <input type=radio name=size value=s> <input type=radio name=size value=m> </form> </fieldset>`,
    schema: {"type": "object", "properties": {"size": {"type": "string", "anyOf": [{"type": "string", "const": "s"}, {"type": "string", "const": "m"}], "enum": ["s", "m"]}}, "required": []},
  },
  {
    name: "FieldsetDescription_Checkbox_Multiple_Basic",
    html: `<form id="form" toolname="mytool" tooldescription="perform task"> <fieldset toolparamdescription="CHECKBOX_DESC"> <input type=checkbox name=colors value=red> <input type=checkbox name=colors value=green> <input type=checkbox name=colors value=blue> </fieldset> </form>`,
    schema: {"type": "object", "properties": {"colors": {"type": "array", "items": {"type": "string", "anyOf": [{"type": "string", "const": "red"}, {"type": "string", "const": "green"}, {"type": "string", "const": "blue"}], "enum": ["red", "green", "blue"]}, "uniqueItems": true, "description": "CHECKBOX_DESC"}}, "required": []},
  },
];
