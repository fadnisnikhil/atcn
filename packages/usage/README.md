# @atcn/usage

Opt-in usage reporting for the ATCN tools. It is off by default, and no collector address is built in. A report is sent only if both of these hold:

- the user answered yes to `npx atcn init` on this machine;
- `ATCN_USAGE_URL` is set.

`ATCN_USAGE_DISABLED=1` and `DO_NOT_TRACK=1` always turn it off. Each report has exactly the fields in `UsageReportSchema`: no task data, amounts, names or keys.

Payload and configuration: [docs/USAGE_DATA.md](../../docs/USAGE_DATA.md). Part of [ATCN](../../README.md). Apache-2.0.
