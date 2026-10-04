# @atcn/usage

Opt-in, anonymous usage reporting for the [ATCN](https://github.com/fadnisnikhil/atcn) tools. You don't need to install it yourself: the SDK and the local runner use it.

It is off by default, and no collector address is built in. A report is sent only if both of these hold:

- you answered yes to `npx atcn init` on this machine;
- `ATCN_USAGE_URL` is set.

`ATCN_USAGE_DISABLED=1` and `DO_NOT_TRACK=1` always turn it off. Each report has exactly the fields in `UsageReportSchema`: no task data, amounts, names or keys.

Payload and configuration: [usage data](https://github.com/fadnisnikhil/atcn/blob/main/docs/USAGE_DATA.md). Part of [ATCN](https://github.com/fadnisnikhil/atcn). Apache-2.0.
