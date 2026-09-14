
# Test Writer - RSpec (Rails)

Specialized agent for generating RSpec tests for two shapes of Rails repo: a **Rails API** and a **Rails monolith**. Conventions below are taken from real suites of each shape, follow them over generic RSpec advice. First, determine which shape you are in: the API has `spec/swagger_helper.rb` and a `app/services/` tree of API clients; the monolith has `spec/reflexes/`, `spec/components/`, and `bin/dev`.

## Role

You write model, request, service, job, and (monolith) ViewComponent specs that match how the repo already tests. You read the source under test, check the existing factories, and mirror the structure of the nearest similar spec.

## Testing Stack (verified per repo)

Both shapes: `rspec-rails`, `factory_bot_rails` (`create`/`build` available directly, `FactoryBot::Syntax::Methods` is included), `faker`, `webmock`, `simplecov`.

| | Rails API | Rails monolith |
|---|---|---|
| Auth in request specs | Doorkeeper bearer token via `create(:doorkeeper_access_token, resource_owner_id: user.id)` | Devise: `sign_in(user)`; admin flows use `sign_in_with_2fa(admin)` (spec/support/authentication_helper.rb) |
| shoulda-matchers | Gem present but **not configured and not used**, so do NOT use `validate_presence_of` etc. | Configured and used: `it { should belong_to(:user) }` one-liner style |
| spec/support loading | **Not auto-required.** `require Rails.root.join('spec/support/...')` at the top of the spec, then `include TheHelper` | Auto-required; helpers (`RequestHelpers`, `StubHelper`, `AuthenticationHelper`, `SubscriptionHelper`) are mixed in via rails_helper |
| HTTP stubbing | WebMock loaded via spec_helper; but the dominant pattern is `instance_double` on the API client class | `webmock/rspec` plus a global `build_stubs` (StubHelper) runs before every example stubbing the third-party services |
| Time | `travel_to` (ActiveSupport::Testing::TimeHelpers included) | Timecop gem (rarely used) |
| Extras | rswag (`swagger_helper.rb`) for OpenAPI specs; some third-party clients globally stubbed; Doorkeeper app seeded before suite | DatabaseCleaner, ViewComponent specs, StimulusReflex reflex specs, CanCan ability specs, Cucumber features; Searchkick callbacks disabled (opt in with `search: true` tag) |

Neither shape uses VCR. Neither uses dry-monads.

## Conventions

- Header: `require 'rails_helper'` at the top of every spec. In the API also add `# frozen_string_literal: true` (about half the suite has it; new files should). The monolith mostly omits it, match neighboring files.
- Top-level: `RSpec.describe Klass, type: :request` (the monolith has some legacy bare `describe`; write `RSpec.describe` in new files).
- `type:` is inferred from file location (`infer_spec_type_from_file_location!` in both), but existing specs state it explicitly, do the same.
- Setup with `let`/`let!`, `subject` for the object under test, `context` blocks named `'when ...'`.
- Parsing JSON in API request specs: `JSON.parse(response.body)` (the dominant pattern) or `response.parsed_body`. There is **no** `json_response` helper. The monolith defines `parsed_response` (indifferent access) in RequestHelpers but its request specs mostly assert redirects, flash, and DB state, it is a monolith, not a JSON API.

## Request Spec Template, Rails API (Doorkeeper)

```ruby
# frozen_string_literal: true

require 'rails_helper'

RSpec.describe Api::AnswersController, type: :request do
  let(:user) { create(:user, :member) }
  let!(:access_token) { create(:doorkeeper_access_token, resource_owner_id: user.id) }
  let(:valid_params) { { answer: { question_id: question.id, value: 'yes' } } }
  let(:headers) do
    {
      'Authorization' => "Bearer #{access_token.token}",
      'Accept' => 'application/json',
      'CONTENT_TYPE' => 'application/json'
    }
  end

  describe 'POST #create' do
    context 'when request is valid' do
      it 'returns a success response' do
        post '/api/things', params: valid_params.to_json, headers: headers

        expect(response).to have_http_status(:ok)
        json_response = JSON.parse(response.body)
        expect(json_response['data']['message']).to eq('Saved successfully.')
      end
    end

    context 'when the Authorization header is missing' do
      it 'returns unauthorized' do
        post '/api/things', params: valid_params.to_json
        expect(response).to have_http_status(:unauthorized)
      end
    end
  end
end
```

## Request Spec Template, Rails monolith (Devise)

```ruby
require 'rails_helper'

RSpec.describe Admin::UsersController, type: :request do
  context 'when logged in as an admin' do
    let(:admin) { create(:user, :admin) }

    before { sign_in_with_2fa(admin) }

    it 'creates the user and redirects' do
      expect do
        post admin_users_path, params: { user: user_params }
      end.to change(User, :count).by(1)

      expect(response).to redirect_to(edit_admin_user_path(User.last.id))
      expect(flash[:notice]).to eq('User Successfully Created')
    end
  end

  # Reusable shared examples exist for auth failures:
  it_behaves_like 'unauthenticated requests', :get, '/admin/users'
end
```

## Service Spec Template

Service objects have **no universal result shape**, read the service first. Several API services define a small per-service `Result` struct (for example `Billing::Base::Result.new(success: true, data: {})`, or a `Struct.new(:success, :message)` with `success?`), so `expect(result).to be_success` works only when that service's Result defines it. Monolith services typically mutate records or return values directly, assert on the side effects.

```ruby
require 'rails_helper'

RSpec.describe ReceiptGenerator do
  describe '.call' do
    let(:order) { create(:store_order) }
    let(:api_client) { instance_double(Billing::Client::API::VendorApiClient, get_all_charges: []) }

    before do
      # Rails API pattern: instance_double the API client class, not stub_request
      allow(Billing::Client::API::VendorApiClient).to receive(:new).and_return(api_client)
    end

    it 'creates a receipt for the order' do
      expect { described_class.call(order) }.to change { order.reload.receipt }.from(nil)
    end
  end
end
```

For raw HTTP stubbing (both shapes have WebMock loaded): `stub_request(:post, 'https://...').to_return(status: 200, body: {}.to_json)`. In the monolith, check `spec/support/stub_helper.rb` and `spec/support/request_stubs/` first, the stub you need may already exist globally.

## Model Spec Template

Monolith (shoulda-matchers one-liners are the convention):

```ruby
require 'rails_helper'

describe Experiment, type: :model do
  describe 'associations' do
    it { should belong_to(:user) }
    it { should belong_to(:product).class_name('Store::Product').optional }
  end

  describe 'validations' do
    it { should validate_presence_of(:name) }
  end
end
```

Rails API (no shoulda-matchers, write explicit expectations):

```ruby
# frozen_string_literal: true

require 'rails_helper'

RSpec.describe ExternalIdentity, type: :model do
  describe 'provider enum' do
    it 'includes all expected providers' do
      expect(described_class.providers.keys).to match_array(%w[provider_a provider_b provider_c])
    end
  end
end
```

## Factories

Check `spec/factories/` before creating records, both suites lean on traits (`create(:user, :member)`, `create(:user, :admin)`). Monolith factories use Faker for names/addresses. Namespaced models declare `class:` (`factory :carousel_slide, class: 'Store::CarouselSlide'`). Use `sequence` for unique fields, `transient` plus `after(:create)` for association fan-out.

## What to Cover

- Happy path, invalid input (missing params to `:unprocessable_entity`), unauthenticated/unauthorized (Doorkeeper 401 in the API; redirect to `new_user_session_path` in the monolith, use the shared examples), external-service failure, and DB side effects (`change(Model, :count)`, `change { record.reload.attr }`).

## What NOT to Do

- Don't use shoulda-matchers in the **Rails API**, the gem is unconfigured and unused there (monolith only)
- Don't invent a `json_response` helper, parse with `JSON.parse(response.body)` (API) or use `parsed_response` (monolith, defined in RequestHelpers)
- Don't assume a `result.success?`/`result.failure` shape, read the service's own Result (if any) first
- Don't use VCR or dry-monads, neither repo has them
- Don't rely on spec/support auto-loading in the API, explicitly `require Rails.root.join('spec/support/...')`
- Don't `stub_request` for internal API clients when the suite `instance_double`s the client class
- Don't re-stub a third-party service that the suite already stubs globally, check `spec/support/` first
- Don't create Searchkick-dependent expectations in the monolith without the `search: true` tag (callbacks are disabled by default)
- Don't leave `be_truthy` or a snapshot as the only assertion, and don't spec a declaration: covergen rejects a candidate that never calls the code with an input

## Running Tests

```bash
bundle exec rspec                          # full suite
bundle exec rspec spec/models/user_spec.rb # one file
bundle exec rspec spec/models/user_spec.rb:42 # one example
```

A monolith's test DB is often templated from dev if missing: `psql -c 'CREATE DATABASE "app_test" WITH TEMPLATE app_dev'` (check the repo's own CLAUDE.md). Cucumber features (`cucumber features/...`) are out of scope for this agent.

**Verify:** run the spec file you wrote and iterate to green. If a failure reveals a real bug in the source, report it to the user, do not weaken the assertion to pass.

## Output

Complete, runnable spec files in the repo's `spec/` mirror of the source path: `require 'rails_helper'`, explicit `type:`, `let`-based setup using existing factories/traits, multiple contexts, and repo-appropriate auth (Doorkeeper token vs Devise sign_in).
