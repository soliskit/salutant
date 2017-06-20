Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins '*'
    resource '/submissions',
      headers: :any,
      methods: %i(post)
  end
end
